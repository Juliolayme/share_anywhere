import Foundation
import SATransferRuntime
import StreamWebRTC

/// StreamWebRTC behind the runtime's `PeerFactory` (docs/ADR/0026-ios-webrtc-dependency.md): one factory per process,
/// unified plan, gather once, and an ordered reliable `sa-transfer/1` data channel. libwebrtc calls delegates on its
/// signaling thread; the callbacks hand events to the controllers, which order them on their own queue.
final class WebRTCPeerFactory: PeerFactory, @unchecked Sendable {
    static let shared = WebRTCPeerFactory()

    private let factory: RTCPeerConnectionFactory

    private init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
    }

    func make(iceServers: [ICEServer], callbacks: PeerCallbacks) async throws -> any PeerLink {
        let config = RTCConfiguration()
        config.iceServers = iceServers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherOnce
        let peer = WebRTCPeer(callbacks: callbacks)
        guard let pc = factory.peerConnection(with: config, constraints: WebRTCPeer.constraints, delegate: peer) else {
            throw WebRTCError("peer connection")
        }
        peer.attach(pc)
        return peer
    }
}

struct WebRTCError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

final class WebRTCPeer: NSObject, PeerLink, RTCPeerConnectionDelegate, @unchecked Sendable {
    static let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    private let callbacks: PeerCallbacks
    private let lock = NSLock()
    private var pc: RTCPeerConnection?
    private var channels: [WebRTCChannel] = []

    init(callbacks: PeerCallbacks) { self.callbacks = callbacks }

    func attach(_ pc: RTCPeerConnection) { lock.locked { self.pc = pc } }

    private var connection: RTCPeerConnection? { lock.locked { pc } }

    var state: PeerState { connection.map { WebRTCPeer.map($0.connectionState) } ?? .closed }

    static func map(_ s: RTCPeerConnectionState) -> PeerState {
        switch s {
        case .new: .new
        case .connecting: .connecting
        case .connected: .connected
        case .disconnected: .disconnected
        case .failed: .failed
        case .closed: .closed
        @unknown default: .failed
        }
    }

    func createDataChannel(label: String) throws -> any DataChannelLink {
        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        guard let dc = connection?.dataChannel(forLabel: label, configuration: config) else { throw WebRTCError("data channel") }
        let ch = WebRTCChannel(dc)
        lock.locked { channels.append(ch) }
        return ch
    }

    func offer() async throws -> SDPJSON {
        guard let pc = connection else { throw WebRTCError("closed") }
        let sdp: RTCSessionDescription = try await withCheckedThrowingContinuation { c in
            pc.offer(for: WebRTCPeer.constraints) { sdp, error in
                if let sdp { c.resume(returning: sdp) } else { c.resume(throwing: error ?? WebRTCError("offer")) }
            }
        }
        try await setLocal(pc, sdp)
        return SDPJSON(type: "offer", sdp: sdp.sdp)
    }

    func answer() async throws -> SDPJSON {
        guard let pc = connection else { throw WebRTCError("closed") }
        let sdp: RTCSessionDescription = try await withCheckedThrowingContinuation { c in
            pc.answer(for: WebRTCPeer.constraints) { sdp, error in
                if let sdp { c.resume(returning: sdp) } else { c.resume(throwing: error ?? WebRTCError("answer")) }
            }
        }
        try await setLocal(pc, sdp)
        return SDPJSON(type: "answer", sdp: sdp.sdp)
    }

    private func setLocal(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
            pc.setLocalDescription(sdp) { error in
                if let error { c.resume(throwing: error) } else { c.resume() }
            }
        }
    }

    func setRemote(_ sdp: SDPJSON) async throws {
        guard let pc = connection else { throw WebRTCError("closed") }
        let type: RTCSdpType = switch sdp.type {
        case "offer": .offer
        case "answer": .answer
        case "pranswer": .prAnswer
        default: throw WebRTCError("sdp type")
        }
        let desc = RTCSessionDescription(type: type, sdp: sdp.sdp)
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
            pc.setRemoteDescription(desc) { error in
                if let error { c.resume(throwing: error) } else { c.resume() }
            }
        }
    }

    func add(_ candidate: CandidateJSON) async {
        guard let pc = connection else { return }
        let c = RTCIceCandidate(
            sdp: candidate.candidate,
            sdpMLineIndex: Int32(candidate.sdpMLineIndex ?? 0),
            sdpMid: candidate.sdpMid ?? "0"
        )
        await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
            pc.add(c) { _ in k.resume() }
        }
    }

    func selectedRoute() async -> String? {
        guard let pc = connection else { return nil }
        let report: RTCStatisticsReport = await withCheckedContinuation { c in pc.statistics { c.resume(returning: $0) } }
        let stats = report.statistics
        let pairId = stats.values.first { $0.type == "transport" }?.values["selectedCandidatePairId"] as? String
        let pair = stats.values.first { s in
            s.type == "candidate-pair" &&
                (s.id == pairId || (
                    pairId == nil && (s.values["nominated"] as? NSNumber)?.boolValue == true &&
                        s.values["state"] as? String == "succeeded"
                ))
        }
        guard let pair else { return nil }
        func type(_ key: String) -> String? {
            guard let id = pair.values[key] as? String else { return nil }
            return stats[id]?.values["candidateType"] as? String
        }
        return type("localCandidateId") == "relay" || type("remoteCandidateId") == "relay" ? "relay" : "direct"
    }

    func close() {
        let (pc, chs) = lock.locked { () -> (RTCPeerConnection?, [WebRTCChannel]) in
            defer {
                self.pc = nil
                channels.removeAll()
            }
            return (self.pc, channels)
        }
        for ch in chs {
            ch.close()
        }
        pc?.close()
    }

    // MARK: RTCPeerConnectionDelegate

    func peerConnection(_: RTCPeerConnection, didChange _: RTCSignalingState) {}
    func peerConnection(_: RTCPeerConnection, didAdd _: RTCMediaStream) {}
    func peerConnection(_: RTCPeerConnection, didRemove _: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_: RTCPeerConnection) {}
    func peerConnection(_: RTCPeerConnection, didChange _: RTCIceConnectionState) {}
    func peerConnection(_: RTCPeerConnection, didChange _: RTCIceGatheringState) {}
    func peerConnection(_: RTCPeerConnection, didRemove _: [RTCIceCandidate]) {}

    func peerConnection(_: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        callbacks.onState(WebRTCPeer.map(newState))
    }

    func peerConnection(_: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        callbacks.onCandidate(CandidateJSON(
            candidate: candidate.sdp,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: Int(candidate.sdpMLineIndex)
        ))
    }

    func peerConnection(_: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        let ch = WebRTCChannel(dataChannel)
        lock.locked { channels.append(ch) }
        callbacks.onDataChannel(ch)
    }
}

/// An `RTCDataChannel` as the engine's channel. Binary messages only (docs/TRANSFER_PROTOCOL.md §2).
final class WebRTCChannel: NSObject, DataChannelLink, RTCDataChannelDelegate, @unchecked Sendable {
    private let dc: RTCDataChannel
    private let lock = NSLock()
    private var listener: (any TransferChannelListener)?
    private var openActions: [@Sendable () -> Void] = []
    private var opened = false
    /// Messages (and a close) that arrived before the engine attached its listener: the peer's HELLO can come right
    /// after the channel opens, before this side has created its connection.
    private var early: [[UInt8]] = []
    private var closedEarly = false

    init(_ dc: RTCDataChannel) {
        self.dc = dc
        super.init()
        dc.delegate = self
    }

    var label: String { dc.label }
    var bufferedAmount: Int { Int(dc.bufferedAmount) }
    var isOpen: Bool { dc.readyState == .open }
    /// libwebrtc does not expose the SCTP limit; 64 KiB frames fit every browser's limit (§2).
    var maxMessageSize: Int? { nil }

    @discardableResult
    func send(_ data: [UInt8]) -> Bool { isOpen && dc.sendData(RTCDataBuffer(data: Data(data), isBinary: true)) }

    func close() { dc.close() }

    func setListener(_ listener: (any TransferChannelListener)?) {
        let (queued, closed) = lock.locked { () -> ([[UInt8]], Bool) in
            self.listener = listener
            guard listener != nil else { return ([], false) }
            defer {
                early.removeAll()
                closedEarly = false
            }
            return (early, closedEarly)
        }
        for m in queued {
            listener?.onMessage(m)
        }
        if closed { listener?.onClose() }
    }

    func whenOpen(_ action: @escaping @Sendable () -> Void) {
        let now = lock.locked { () -> Bool in
            if opened || dc.readyState == .open {
                opened = true
                return true
            }
            openActions.append(action)
            return false
        }
        if now { action() }
    }

    private var current: (any TransferChannelListener)? { lock.locked { listener } }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            let actions = lock.locked { () -> [@Sendable () -> Void] in
                opened = true
                defer { openActions.removeAll() }
                return openActions
            }
            for a in actions {
                a()
            }
        case .closed:
            let l = lock.locked { () -> (any TransferChannelListener)? in
                if listener == nil { closedEarly = true }
                return listener
            }
            l?.onClose()
        default:
            break
        }
    }

    func dataChannel(_: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard buffer.isBinary else { return }
        let bytes = [UInt8](buffer.data)
        let l = lock.locked { () -> (any TransferChannelListener)? in
            if listener == nil { early.append(bytes) }
            return listener
        }
        l?.onMessage(bytes)
    }

    func dataChannel(_: RTCDataChannel, didChangeBufferedAmount _: UInt64) { current?.onBufferedAmountChange() }
}

extension NSLock {
    /// `withLock` without depending on the SDK's availability of `NSLocking.withLock` on iOS 16.
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
