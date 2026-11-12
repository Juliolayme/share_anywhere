import Foundation
@_exported import SAProtocol

/// The slice of a WebRTC DataChannel the engine uses (`sa-transfer/1`, ordered, reliable, binary), so the engine runs
/// over an in-memory pair in tests. Implementations are thread-safe; listener calls for one channel are serial.
public protocol TransferChannel: AnyObject, Sendable {
    var bufferedAmount: Int { get }
    var isOpen: Bool { get }
    /// Largest message the peer accepts (SCTP max message size); nil when unknown.
    var maxMessageSize: Int? { get }
    /// Queues one message; false when the channel is not open.
    @discardableResult func send(_ data: [UInt8]) -> Bool
    func close()
    /// The channel keeps the listener until it is replaced.
    func setListener(_ listener: (any TransferChannelListener)?)
}

public protocol TransferChannelListener: AnyObject, Sendable {
    func onMessage(_ data: [UInt8])
    /// bufferedAmount dropped (the engine checks it against its low-water mark).
    func onBufferedAmountChange()
    func onClose()
}

/// Waits until bufferedAmount drops to a mark or the channel closes; `signal()` is called on every change. Several
/// tasks may wait at once (the block pump and a fatal error's close), so each signal wakes every waiter.
public final class Drain: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    public init() {}

    public func until(_ channel: any TransferChannel, low: Int) async {
        while channel.isOpen, channel.bufferedAmount > low {
            let id = UUID()
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                lock.lock()
                waiters[id] = c
                lock.unlock()
                // A signal may have come before the registration: re-check.
                if !channel.isOpen || channel.bufferedAmount <= low { wake(id) }
            }
        }
    }

    public func signal() {
        lock.lock()
        let all = waiters
        waiters.removeAll()
        lock.unlock()
        for c in all.values {
            c.resume()
        }
    }

    private func wake(_ id: UUID) {
        lock.lock()
        let c = waiters.removeValue(forKey: id)
        lock.unlock()
        c?.resume()
    }
}

/// An unbounded stream and its continuation (`AsyncStream.makeStream` without relying on its availability).
func makeStream<T: Sendable>(of _: T.Type = T.self) -> (AsyncStream<T>, AsyncStream<T>.Continuation) {
    var continuation: AsyncStream<T>.Continuation!
    let stream = AsyncStream<T> { continuation = $0 }
    return (stream, continuation)
}

/// What a connection reads from its channel, in arrival order.
enum ChannelEvent: Sendable {
    case message([UInt8])
    case closed
}

/// Bridges listener callbacks into an ordered stream; buffer changes go straight to the drain so a waiting pump is
/// never stuck behind queued messages.
final class ChannelInbox: TransferChannelListener {
    private let continuation: AsyncStream<ChannelEvent>.Continuation
    private let drain: Drain

    init(_ continuation: AsyncStream<ChannelEvent>.Continuation, _ drain: Drain) {
        self.continuation = continuation
        self.drain = drain
    }

    func onMessage(_ data: [UInt8]) { continuation.yield(.message(data)) }

    func onBufferedAmountChange() { drain.signal() }

    func onClose() {
        drain.signal()
        continuation.yield(.closed)
    }
}

/// Hashes `size` bytes read through `read` in chunks, reporting progress.
public func hashStream(
    size: Int64,
    read: (Int64, Int) async throws -> [UInt8],
    onProgress: (Int64) -> Void = { _ in },
    chunk: Int = 4 * 1024 * 1024
) async throws -> String {
    var h = StreamHasher()
    var off: Int64 = 0
    while off < size {
        let data = try await read(off, Int(min(Int64(chunk), size - off)))
        if data.isEmpty { throw TransferIOError("short read at \(off)") }
        h.update(offset: off, data)
        off += Int64(data.count)
        onProgress(off)
    }
    return h.hex()
}

/// A storage or file read failure (ERROR storage_error on the receiver, file_unreadable on the sender).
public struct TransferIOError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The device ran out of space while writing (ERROR storage_full).
public struct StorageFullError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

func describe(_ error: any Error) -> String {
    String(describing: error)
}
