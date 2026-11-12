import Foundation
@testable import SATransferEngine

/// In-memory ordered reliable channel pair, as Android's MemChannel: one delivery task per direction keeps messages in
/// order (even with `delayMs`), bufferedAmount drops as messages are delivered, and close queues behind the data.
final class MemChannel: TransferChannel, @unchecked Sendable {
    private let lock = NSLock()
    weak var peer: MemChannel?
    let maxMessageSize: Int?
    private var _buffered = 0
    private var state = "open"
    private var listener: (any TransferChannelListener)?
    private var outbox: AsyncStream<[UInt8]?>.Continuation?
    private(set) var sent = 0
    /// Test hook: delay each delivery (a slow link).
    var delayMs: UInt64 = 0

    init(max: Int?) { maxMessageSize = max }

    static func pair(max: Int? = 65536) -> (MemChannel, MemChannel) {
        let a = MemChannel(max: max), b = MemChannel(max: max)
        a.peer = b
        b.peer = a
        a.startDelivery()
        b.startDelivery()
        return (a, b)
    }

    var bufferedAmount: Int { lock.withLock { _buffered } }
    var isOpen: Bool { lock.withLock { state == "open" } }

    func setListener(_ listener: (any TransferChannelListener)?) { lock.withLock { self.listener = listener } }

    private var currentListener: (any TransferChannelListener)? { lock.withLock { listener } }

    @discardableResult
    func send(_ data: [UInt8]) -> Bool {
        guard isOpen else { return false }
        if let max = maxMessageSize { precondition(data.count <= max, "message of \(data.count) bytes over the limit") }
        lock.withLock {
            sent += 1
            _buffered += data.count
        }
        outbox?.yield(data)
        return true
    }

    func close() {
        let go = lock.withLock { () -> Bool in
            guard state == "open" else { return false }
            state = "closing"
            return true
        }
        if go { outbox?.yield(nil) } // queued deliveries first, then both ends close
    }

    private func setState(_ s: String) { lock.withLock { state = s } }

    private func startDelivery() {
        let (stream, continuation) = makeStream(of: [UInt8]?.self)
        outbox = continuation
        Task { [weak self] in
            for await msg in stream {
                guard let self, let peer = self.peer else { return }
                let d = self.delayMs
                if d > 0 { try? await Task.sleep(nanoseconds: d * 1_000_000) }
                guard let msg else {
                    self.setState("closed")
                    peer.setState("closed")
                    self.currentListener?.onClose()
                    peer.currentListener?.onClose()
                    return
                }
                self.lock.withLock { self._buffered -= msg.count }
                self.currentListener?.onBufferedAmountChange()
                if peer.isOpen || peer.lock.withLock({ peer.state == "closing" }) { peer.currentListener?.onMessage(msg) }
            }
        }
    }
}

actor MemorySink: Sink {
    private(set) var bytes: [UInt8]
    private(set) var writes = 0

    init(size: Int64) { bytes = [UInt8](repeating: 0, count: Int(size)) }
    init(bytes: [UInt8]) { self.bytes = bytes }

    func write(offset: Int64, _ data: [UInt8]) async throws {
        writes += 1
        bytes.replaceSubrange(Int(offset) ..< Int(offset) + data.count, with: data)
    }

    func read(offset: Int64, length: Int) async throws -> [UInt8] { Array(bytes[Int(offset) ..< Int(offset) + length]) }

    func flush() async throws {}

    func put(at offset: Int, _ data: ArraySlice<UInt8>) { bytes.replaceSubrange(offset ..< offset + data.count, with: data) }
}

final class MemorySource: FileSource, @unchecked Sendable {
    let data: [UInt8]
    private let lock = NSLock()
    private var _reads = 0
    var reads: Int { lock.withLock { _reads } }

    init(_ data: [UInt8]) { self.data = data }

    var size: Int64 { Int64(data.count) }

    func read(offset: Int64, length: Int) async throws -> [UInt8] {
        lock.withLock { _reads += 1 }
        return Array(data[Int(offset) ..< min(data.count, Int(offset) + length)])
    }
}

/// Deterministic pseudo-random bytes (xorshift), as the Web's bytesOf.
func bytesOf(_ size: Int, seed: Int32 = 1) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: size)
    var x: Int32 = seed == 0 ? 1 : seed
    for i in 0 ..< size {
        x ^= x << 13
        x ^= Int32(bitPattern: UInt32(bitPattern: x) >> 17)
        x ^= x << 5
        out[i] = UInt8(truncatingIfNeeded: x)
    }
    return out
}

struct Timeout: Error {}

func until(_ timeout: TimeInterval = 20, _ cond: () async -> Bool) async throws {
    let end = Date().addingTimeInterval(timeout)
    while await !cond() {
        if Date() > end { throw Timeout() }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
}

/// Thread-safe recorder for engine callbacks.
final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _complete = false
    private var _errors: [String] = []
    private var _done: [(Int, Bool)] = []
    private var _authorized: String?

    var complete: Bool { lock.withLock { _complete } }
    var errors: [String] { lock.withLock { _errors } }
    var doneFiles: [(Int, Bool)] { lock.withLock { _done } }
    var authorized: String? { lock.withLock { _authorized } }

    func setComplete() { lock.withLock { _complete = true } }
    func error(_ code: String) { lock.withLock { _errors.append(code) } }
    func fileDone(_ f: Int, _ ok: Bool) { lock.withLock { _done.append((f, ok)) } }
    func authorize(_ p: String) { lock.withLock { _authorized = p } }
}

struct TxEvents: SenderEvents {
    let r: Recorder
    func onAuthorized(participantId: String) { r.authorize(participantId) }
    func onComplete() { r.setComplete() }
    func onError(code: String, fatal _: Bool, message _: String?) { r.error(code) }
}

struct RxEvents: ReceiverEvents {
    let r: Recorder
    func onComplete() { r.setComplete() }
    func onFileDone(file: Int, ok: Bool) { r.fileDone(file, ok) }
    func onError(code: String, fatal _: Bool, message _: String?) { r.error(code) }
}

/// The receiver side's persisted state across connections.
actor RxStore {
    var sinks: [Int: MemorySink] = [:]
    var persisted: [Int: Bitmap] = [:]

    func sink(_ file: Int, size: Int64) -> MemorySink {
        if let s = sinks[file] { return s }
        let s = MemorySink(size: size)
        sinks[file] = s
        return s
    }

    func setSink(_ file: Int, _ s: MemorySink) { sinks[file] = s }
    func bitmap(_ file: Int) -> Bitmap? { persisted[file] }
    func persist(_ file: Int, _ b: Bitmap) { persisted[file] = b }
}
