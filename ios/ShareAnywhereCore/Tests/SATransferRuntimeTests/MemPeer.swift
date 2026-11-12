import Foundation
@testable import SATransferRuntime

/// An in-memory ordered, reliable data channel pair with the open notification of a WebRTC channel.
final class MemDataChannel: DataChannelLink, @unchecked Sendable {
    let label: String
    let maxMessageSize: Int? = 65536
    weak var peer: MemDataChannel?
    private let lock = NSLock()
    private var state = "connecting"
    private var buffered = 0
    private var listener: (any TransferChannelListener)?
    private var openActions: [@Sendable () -> Void] = []
    /// Messages that arrived before a listener was attached (as the WebRTC adapter keeps them).
    private var early: [[UInt8]] = []
    private var outbox: AsyncStream<[UInt8]?>.Continuation?
    /// Test hook: delay each delivery (a slow link).
    let delayMs: UInt64

    init(label: String, delayMs: UInt64) {
        self.label = label
        self.delayMs = delayMs
    }

    var bufferedAmount: Int { lock.locked { buffered } }
    var isOpen: Bool { lock.locked { state == "open" } }

    func setListener(_ listener: (any TransferChannelListener)?) {
        let queued = lock.locked { () -> [[UInt8]] in
            self.listener = listener
            guard listener != nil else { return [] }
            defer { early.removeAll() }
            return early
        }
        for m in queued {
            listener?.onMessage(m)
        }
    }

    /// Delivers to the listener, or keeps the message until one is attached.
    fileprivate func deliver(_ msg: [UInt8]) {
        let l = lock.locked { () -> (any TransferChannelListener)? in
            if listener == nil { early.append(msg) }
            return listener
        }
        l?.onMessage(msg)
    }

    private var currentListener: (any TransferChannelListener)? { lock.locked { listener } }

    func whenOpen(_ action: @escaping @Sendable () -> Void) {
        let now = lock.locked { () -> Bool in
            if state == "open" { return true }
            openActions.append(action)
            return false
        }
        if now { action() }
    }

    static func pair(label: String, delayMs: UInt64) -> (MemDataChannel, MemDataChannel) {
        let a = MemDataChannel(label: label, delayMs: delayMs), b = MemDataChannel(label: label, delayMs: delayMs)
        a.peer = b
        b.peer = a
        return (a, b)
    }

    func open() {
        startDelivery()
        let actions = lock.locked { () -> [@Sendable () -> Void] in
            state = "open"
            defer { openActions.removeAll() }
            return openActions
        }
        for a in actions {
            a()
        }
    }

    @discardableResult
    func send(_ data: [UInt8]) -> Bool {
        guard isOpen else { return false }
        lock.locked { buffered += data.count }
        outbox?.yield(data)
        return true
    }

    func close() {
        let go = lock.locked { () -> Bool in
            guard state == "open" || state == "connecting" else { return false }
            let wasOpen = state == "open"
            state = "closing"
            return wasOpen
        }
        if go { outbox?.yield(nil) } else { lock.locked { if state == "closing" { state = "closed" } } }
    }

    /// Drops the link at once (no queued data delivered): both ends close.
    func sever() {
        lock.locked { state = "closed" }
        outbox?.finish()
        peer?.lock.locked { peer?.state = "closed" }
        currentListener?.onClose()
        peer?.currentListener?.onClose()
    }

    private func setState(_ s: String) { lock.locked { state = s } }

    private func startDelivery() {
        let (stream, continuation) = makeChannel(of: [UInt8]?.self)
        outbox = continuation
        Task { [weak self] in
            for await msg in stream {
                guard let self, let peer = self.peer else { return }
                if self.delayMs > 0 { try? await Task.sleep(nanoseconds: self.delayMs * 1_000_000) }
                guard let msg else {
                    self.setState("closed")
                    peer.setState("closed")
                    self.currentListener?.onClose()
                    peer.currentListener?.onClose()
                    return
                }
                self.lock.locked { self.buffered -= msg.count }
                self.currentListener?.onBufferedAmountChange()
                if peer.lock.locked({ peer.state == "open" || peer.state == "closing" }) { peer.deliver(msg) }
            }
        }
    }
}

/// Peers linked through a shared registry: the offer names the offering peer, the answering side connects to it, and
/// the offerer's data channel appears on the answerer once the answer is applied.
final class MemPeerFactory: PeerFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var offers: [String: MemPeer] = [:]
    private(set) var made: [MemPeer] = []
    var delayMs: UInt64 = 0
    /// Test hook: the answering side learns about the channel this long after it opened (the HELLO race).
    var announceDelayMs: UInt64 = 0

    func make(iceServers _: [ICEServer], callbacks: PeerCallbacks) async throws -> any PeerLink {
        let p = MemPeer(factory: self, callbacks: callbacks)
        lock.locked { made.append(p) }
        return p
    }

    func register(_ id: String, _ p: MemPeer) { lock.locked { offers[id] = p } }
    func lookup(_ id: String) -> MemPeer? { lock.locked { offers[id] } }

    /// Breaks every live connection (network loss): channels close and both peers report failed.
    func severAll() {
        for p in lock.locked({ made }) {
            p.sever()
        }
    }

    var count: Int { lock.locked { made.count } }
}

final class MemPeer: PeerLink, @unchecked Sendable {
    private let lock = NSLock()
    private weak var factory: MemPeerFactory?
    private let callbacks: PeerCallbacks
    private var _state: PeerState = .new
    private var local: MemDataChannel?
    private var remote: MemDataChannel?
    private var other: MemPeer?
    private let id = UUID().uuidString

    init(factory: MemPeerFactory, callbacks: PeerCallbacks) {
        self.factory = factory
        self.callbacks = callbacks
    }

    var state: PeerState { lock.locked { _state } }

    private func set(_ s: PeerState) {
        let changed = lock.locked { () -> Bool in
            guard _state != s, _state != .closed else { return false }
            _state = s
            return true
        }
        if changed { callbacks.onState(s) }
    }

    func createDataChannel(label: String) throws -> any DataChannelLink {
        let (a, b) = MemDataChannel.pair(label: label, delayMs: factory?.delayMs ?? 0)
        lock.locked {
            local = a
            remote = b
        }
        return a
    }

    func offer() async throws -> SDPJSON {
        factory?.register(id, self)
        callbacks.onCandidate(CandidateJSON(candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0))
        return SDPJSON(type: "offer", sdp: "mem:\(id)")
    }

    func answer() async throws -> SDPJSON {
        callbacks.onCandidate(CandidateJSON(candidate: "candidate:2 1 udp 1 127.0.0.1 10 typ host", sdpMid: "0", sdpMLineIndex: 0))
        return SDPJSON(type: "answer", sdp: "mem-answer:\(id)")
    }

    func setRemote(_ sdp: SDPJSON) async throws {
        if sdp.type == "offer" {
            guard let offerer = factory?.lookup(String(sdp.sdp.dropFirst(4))) else { throw FakeError() }
            lock.locked { other = offerer }
            offerer.lock.locked { offerer.other = self }
            set(.connecting)
            return
        }
        // The answer: both sides connect, the channel shows up on the answerer and opens.
        guard let other = lock.locked({ self.other }) else { throw FakeError() }
        set(.connected)
        other.set(.connected)
        let (a, b) = lock.locked { (local, remote) }
        if let a, let b {
            let late = factory?.announceDelayMs ?? 0
            if late == 0 {
                other.callbacks.onDataChannel(b)
                a.open()
                b.open()
            } else {
                a.open()
                b.open()
                let callbacks = other.callbacks
                Task {
                    try? await Task.sleep(nanoseconds: late * 1_000_000)
                    callbacks.onDataChannel(b)
                }
            }
        }
    }

    func add(_: CandidateJSON) async {}

    func selectedRoute() async -> String? { "direct" }

    func close() {
        let (a, b) = lock.locked { (local, remote) }
        a?.close()
        b?.close()
        set(.closed)
    }

    func sever() {
        guard state == .connected else { return }
        lock.locked { local }?.sever()
        set(.failed)
        lock.locked { other }?.set(.failed)
    }
}
