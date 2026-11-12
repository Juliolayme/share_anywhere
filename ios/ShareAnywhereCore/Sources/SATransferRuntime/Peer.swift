import Foundation

/// The slice of `RTCPeerConnection` the controllers use, so the runtime runs over in-memory peers in `swift test`
/// and over StreamWebRTC in the app (docs/ADR/0026-ios-webrtc-dependency.md).
public enum PeerState: Sendable, Equatable { case new, connecting, connected, disconnected, failed, closed }

public struct ICEServer: Sendable, Equatable {
    public var urls: [String]
    public var username: String?
    public var credential: String?

    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }

    /// ICE servers for a session, as the Web's rtcConfig and Android's `Rtc.iceServers`: the TURN credentials plus a
    /// `stun:` URI on the same host and port. Without credentials, direct candidates may still connect.
    public static func from(_ c: TurnCredentials?) -> [ICEServer] {
        guard let c, !c.uris.isEmpty else { return [] }
        var stun: [String] = []
        for uri in c.uris where uri.hasPrefix("turn:") {
            let s = "stun:" + uri.dropFirst("turn:".count).split(separator: "?", maxSplits: 1)[0]
            if !stun.contains(s) { stun.append(s) }
        }
        var out: [ICEServer] = []
        if !stun.isEmpty { out.append(ICEServer(urls: stun)) }
        out.append(ICEServer(urls: c.uris, username: c.username, credential: c.credential))
        return out
    }
}

/// An `sa-transfer/1` data channel as the engine sees it, plus its label and open notification.
public protocol DataChannelLink: TransferChannel {
    var label: String { get }
    /// Runs `action` once when the channel opens (at once when it is already open).
    func whenOpen(_ action: @escaping @Sendable () -> Void)
}

/// Peer connection callbacks; called on any thread.
public struct PeerCallbacks: Sendable {
    public var onCandidate: @Sendable (CandidateJSON) -> Void
    /// A channel the other side created (the sender's side: the receiver offers and creates the channel).
    public var onDataChannel: @Sendable (any DataChannelLink) -> Void
    public var onState: @Sendable (PeerState) -> Void

    public init(
        onCandidate: @escaping @Sendable (CandidateJSON) -> Void,
        onDataChannel: @escaping @Sendable (any DataChannelLink) -> Void,
        onState: @escaping @Sendable (PeerState) -> Void
    ) {
        self.onCandidate = onCandidate
        self.onDataChannel = onDataChannel
        self.onState = onState
    }
}

public protocol PeerLink: AnyObject, Sendable {
    var state: PeerState { get }
    /// An ordered, reliable data channel created by this side (the receiver's side).
    func createDataChannel(label: String) throws -> any DataChannelLink
    /// Creates an offer and sets it as the local description.
    func offer() async throws -> SDPJSON
    /// Creates an answer and sets it as the local description.
    func answer() async throws -> SDPJSON
    func setRemote(_ sdp: SDPJSON) async throws
    func add(_ candidate: CandidateJSON) async
    /// The selected candidate pair's route: relay when either end is a TURN relay candidate (docs/TRANSFER_PROTOCOL.md §7).
    func selectedRoute() async -> String?
    func close()
}

public protocol PeerFactory: Sendable {
    func make(iceServers: [ICEServer], callbacks: PeerCallbacks) async throws -> any PeerLink
}

/// A value that several tasks read and one owner writes, with a stream of changes for the UI.
public final class StateCell<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Value
    private var watchers: [UUID: AsyncStream<Value>.Continuation] = [:]

    public init(_ value: Value) { current = value }

    public var value: Value { lock.locked { current } }

    public func set(_ value: Value) {
        let all = lock.locked { () -> [AsyncStream<Value>.Continuation] in
            current = value
            return Array(watchers.values)
        }
        for c in all {
            c.yield(value)
        }
    }

    public func update(_ f: (inout Value) -> Void) {
        let (value, all) = lock.locked { () -> (Value, [AsyncStream<Value>.Continuation]) in
            f(&current)
            return (current, Array(watchers.values))
        }
        for c in all {
            c.yield(value)
        }
    }

    /// The current value, then every change (newest wins when the reader is slow).
    public func values() -> AsyncStream<Value> {
        let id = UUID()
        let (stream, continuation) = makeChannel(of: Value.self, newest: true)
        lock.locked {
            watchers[id] = continuation
            continuation.yield(current)
        }
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            lock.locked { watchers[id] = nil }
        }
        return stream
    }
}

func makeChannel<T: Sendable>(of _: T.Type, newest: Bool) -> (AsyncStream<T>, AsyncStream<T>.Continuation) {
    var continuation: AsyncStream<T>.Continuation!
    let stream = AsyncStream<T>(bufferingPolicy: newest ? .bufferingNewest(1) : .unbounded) { continuation = $0 }
    return (stream, continuation)
}

/// Milliseconds since 1970, the runtime's clock.
public typealias MillisClock = @Sendable () -> Int64

public let systemClock: MillisClock = { Int64(Date().timeIntervalSince1970 * 1000) }

/// Sleeps for a number of milliseconds; a test can run it faster.
public typealias Sleeper = @Sendable (Int64) async -> Void

public let systemSleeper: Sleeper = { ms in try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000) }

extension NSLock {
    /// `withLock` without depending on the SDK's availability of `NSLocking.withLock`.
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

/// Runs jobs one at a time in the order they were queued (callbacks from WebRTC and the engine arrive on other
/// threads; a `Task` per callback would not keep their order).
public final class EventQueue: Sendable {
    private let continuation: AsyncStream<@Sendable () async -> Void>.Continuation

    public init() {
        let (stream, continuation) = makeChannel(of: (@Sendable () async -> Void).self)
        self.continuation = continuation
        Task {
            for await job in stream {
                await job()
            }
        }
    }

    public func run(_ job: @escaping @Sendable () async -> Void) { continuation.yield(job) }

    deinit { continuation.finish() }
}
