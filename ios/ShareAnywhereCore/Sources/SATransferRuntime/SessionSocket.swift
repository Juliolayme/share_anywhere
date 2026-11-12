import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// One WebSocket connection: `URLSessionWebSocketTask` in the app, a fake in tests.
public protocol WebSocketConnection: Sendable {
    /// The next text frame; throws once the connection is closed.
    func receive() async throws -> String
    func send(_ text: String) async throws
    func close()
}

public protocol WebSocketConnector: Sendable {
    func connect(_ url: URL) -> any WebSocketConnection
}

/// An unbounded stream and its continuation.
func makeChannel<T: Sendable>(of _: T.Type = T.self) -> (AsyncStream<T>, AsyncStream<T>.Continuation) {
    var continuation: AsyncStream<T>.Continuation!
    let stream = AsyncStream<T> { continuation = $0 }
    return (stream, continuation)
}

/// The app's one WebSocket (docs/API.md §4), shared by every screen that needs live session events, the twin of
/// Android's `SessionSocket`: it fetches a one-time ticket, connects without an `Origin` header (native clients send
/// none; the ticket authenticates), dispatches events, and reconnects with jittered exponential backoff while anything
/// is subscribed. SOCKET_OPEN follows the server's WELCOME, so subscribers reload state after every (re)connect.
/// Outgoing messages go through one queue per connection, so signaling keeps its order. Nothing about tickets or
/// payloads is logged.
public final class SessionSocket: @unchecked Sendable {
    private let base: URL
    private let connector: any WebSocketConnector
    private let ticket: @Sendable () async throws -> String
    private let random: @Sendable () -> Double
    private let pause: @Sendable (Int64) async -> Void

    private let lock = NSLock()
    private var subscribers: [UUID: AsyncStream<SocketEvent>.Continuation] = [:]
    private var loop: Task<Void, Never>?
    private var outbox: AsyncStream<String>.Continuation?
    private var connected = false

    public init(
        baseURL: URL,
        connector: any WebSocketConnector,
        ticket: @escaping @Sendable () async throws -> String,
        random: @escaping @Sendable () -> Double = { Double.random(in: 0 ..< 1) },
        pause: @escaping @Sendable (Int64) async -> Void = { ms in try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }
    ) {
        base = baseURL
        self.connector = connector
        self.ticket = ticket
        self.random = random
        self.pause = pause
    }

    public var isConnected: Bool { lock.locked { connected } }

    /// Live events; the socket stays connected while at least one stream is being iterated.
    public func events() -> AsyncStream<SocketEvent> {
        let (stream, continuation) = makeChannel(of: SocketEvent.self)
        let id = UUID()
        lock.locked {
            subscribers[id] = continuation
            if loop == nil { loop = Task { [weak self] in await self?.run() } }
        }
        continuation.onTermination = { [weak self] _ in self?.release(id) }
        return stream
    }

    /// Sends a client message (signaling). False when the socket is not connected.
    @discardableResult
    public func send(_ message: [String: JSONValue]) -> Bool {
        guard let data = try? APIClient.encoder.encode(message), let text = String(data: data, encoding: .utf8) else { return false }
        return lock.locked {
            guard connected, let outbox else { return false }
            outbox.yield(text)
            return true
        }
    }

    private func release(_ id: UUID) {
        let stop: Task<Void, Never>? = lock.locked {
            subscribers[id] = nil
            guard subscribers.isEmpty else { return nil }
            defer { loop = nil }
            return loop
        }
        stop?.cancel()
    }

    private func emit(_ event: SocketEvent) {
        let all = lock.locked { Array(subscribers.values) }
        for c in all {
            c.yield(event)
        }
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            let welcomed = await (try? connectOnce()) ?? false
            if welcomed { attempt = 0 }
            if Task.isCancelled { break }
            await pause(socketBackoffMs(attempt, random: random()))
            attempt += 1
        }
    }

    /// One connection; returns whether the server welcomed it. Returns when the socket closes.
    private func connectOnce() async throws -> Bool {
        let t = try await ticket()
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + "/v1/ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: t)]
        guard let url = components.url else { return false }
        let conn = connector.connect(url)
        let (queue, out) = makeChannel(of: String.self)
        let writer = Task {
            for await text in queue {
                do { try await conn.send(text) } catch { conn.close(); break }
            }
        }
        lock.locked { outbox = out }
        var welcomed = false
        defer {
            writer.cancel()
            out.finish()
            conn.close()
            let wasConnected = lock.locked { () -> Bool in
                outbox = nil
                defer { connected = false }
                return connected
            }
            if wasConnected { emit(SocketEvent(type: SocketEvent.closed)) }
        }
        await withTaskCancellationHandler {
            while true {
                guard let text = try? await conn.receive() else { break }
                guard let data = text.data(using: .utf8),
                      let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data),
                      case let .string(type)? = obj["type"] else { continue }
                if type == "WELCOME", !welcomed {
                    welcomed = true
                    lock.locked { connected = true }
                    emit(SocketEvent(type: SocketEvent.open))
                }
                emit(SocketEvent(type: type, body: obj))
            }
        } onCancel: {
            conn.close()
        }
        return welcomed
    }
}

#if canImport(Darwin)
    /// `URLSessionWebSocketTask` with a 25 s ping (docs/API.md §4 heartbeat).
    public struct URLSessionWebSocketConnector: WebSocketConnector {
        private let session: URLSession
        public init(session: URLSession = .shared) { self.session = session }

        public func connect(_ url: URL) -> any WebSocketConnection {
            let task = session.webSocketTask(with: url)
            task.maximumMessageSize = 1 << 20
            task.resume()
            return URLSessionWebSocket(task: task)
        }
    }

    final class URLSessionWebSocket: WebSocketConnection, @unchecked Sendable {
        private let task: URLSessionWebSocketTask
        private var pinger: Task<Void, Never>?

        init(task: URLSessionWebSocketTask) {
            self.task = task
            pinger = Task { [weak task] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 25_000_000_000)
                    task?.sendPing { _ in }
                }
            }
        }

        func receive() async throws -> String {
            switch try await task.receive() {
            case let .string(s): return s
            case let .data(d): return String(decoding: d, as: UTF8.self)
            @unknown default: return ""
            }
        }

        func send(_ text: String) async throws { try await task.send(.string(text)) }

        func close() {
            pinger?.cancel()
            task.cancel(with: .normalClosure, reason: nil)
        }
    }
#endif
