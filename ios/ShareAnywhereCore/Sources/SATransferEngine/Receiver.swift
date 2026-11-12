import Foundation

/// Where received bytes go (a file in Documents or a picked folder, or memory in tests).
public protocol Sink: Sendable {
    func write(offset: Int64, _ data: [UInt8]) async throws
    func read(offset: Int64, length: Int) async throws -> [UInt8]
    /// Makes writes durable before the block is acknowledged.
    func flush() async throws
}

/// A file prepared for receiving: its sink and persisted bitmap (empty on a first connect).
public struct PreparedFile: Sendable {
    public var sink: any Sink
    public var bitmap: Bitmap
    public var persist: @Sendable (Bitmap) async throws -> Void
    public var verified: Bool

    public init(sink: any Sink, bitmap: Bitmap, persist: @escaping @Sendable (Bitmap) async throws -> Void, verified: Bool = false) {
        self.sink = sink
        self.bitmap = bitmap
        self.persist = persist
        self.verified = verified
    }
}

public struct ReceiverCounters: Sendable {
    public var blocksReceived = 0
    /// Blocks that arrived although already verified (must stay 0 across a resume).
    public var duplicates = 0
    public var nacksSent = 0
}

/// Engine callbacks, called from the connection's actor (hop to the main actor in the UI layer).
public protocol ReceiverEvents: Sendable {
    func onMeta(files: [FileMetaEntry])
    func onProgress(file: Int, verifiedBytes: Int64)
    func onVerifying(file: Int, hashedBytes: Int64)
    func onFileDone(file: Int, ok: Bool)
    func onComplete()
    func onPaused(byPeer: Bool)
    func onResumed(byPeer: Bool)
    func onError(code: String, fatal: Bool, message: String?)
}

public extension ReceiverEvents {
    func onMeta(files _: [FileMetaEntry]) {}
    func onProgress(file _: Int, verifiedBytes _: Int64) {}
    func onVerifying(file _: Int, hashedBytes _: Int64) {}
    func onFileDone(file _: Int, ok _: Bool) {}
    func onComplete() {}
    func onPaused(byPeer _: Bool) {}
    func onResumed(byPeer _: Bool) {}
    func onError(code _: String, fatal _: Bool, message _: String?) {}
}

public struct NoReceiverEvents: ReceiverEvents { public init() {} }

public struct ReceiverOptions: Sendable {
    public var channel: any TransferChannel
    public var hello: HelloReceiver
    public var prepare: @Sendable (FileMetaEntry) async throws -> PreparedFile
    public var events: any ReceiverEvents
    /// Most blocks assembled at once; more means the sender ignored the window.
    public var maxAssembling = 8

    public init(
        channel: any TransferChannel, hello: HelloReceiver, prepare: @escaping @Sendable (FileMetaEntry) async throws -> PreparedFile,
        events: any ReceiverEvents = NoReceiverEvents()
    ) {
        self.channel = channel
        self.hello = hello
        self.prepare = prepare
        self.events = events
    }
}

/// One receiver ↔ sender connection (docs/TRANSFER_PROTOCOL.md §3–§5), the Swift twin of the Web's ReceiverConnection
/// and Android's `ReceiverConnection`. Block frames are assembled in arrival order; block completion (hash, write,
/// flush, persist, ACK) and control frames run one at a time, in order, on a serial work queue.
public actor ReceiverConnection {
    private struct Target {
        let entry: FileMetaEntry
        var prep: PreparedFile
    }

    private struct Assembly {
        let digest: [UInt8]
        var data: [UInt8]
        var received = 0
    }

    private enum Work: Sendable {
        case control(Frame)
        case complete(file: Int, block: Int, length: Int, digest: [UInt8], data: [UInt8], received: Int)
    }

    private struct BlockKey: Hashable {
        let file: Int
        let block: Int
    }

    private let o: ReceiverOptions
    public private(set) var counters = ReceiverCounters()
    public private(set) var isPaused = false
    private var files: [Int: Target] = [:]
    private var assembling: [BlockKey: Assembly] = [:]
    private var done = Set<Int>()
    private var closed = false
    private var muted = false
    private var authorized = false
    private let drain = Drain()
    private let work: AsyncStream<Work>.Continuation

    public init(_ options: ReceiverOptions) {
        o = options
        let (stream, continuation) = makeStream(of: ChannelEvent.self)
        let (workStream, workContinuation) = makeStream(of: Work.self)
        work = workContinuation
        options.channel.setListener(ChannelInbox(continuation, drain))
        Task { await self.run(stream) }
        Task { await self.runWork(workStream) }
    }

    private func run(_ stream: AsyncStream<ChannelEvent>) async {
        for await event in stream {
            switch event {
            case let .message(data): onFrame(data)
            case .closed: end(ErrorCode.closed, fatal: false, message: nil)
            }
        }
    }

    /// The serial work queue: control frames and completed blocks, strictly in arrival order.
    private func runWork(_ stream: AsyncStream<Work>) async {
        for await job in stream {
            do {
                switch job {
                case let .control(f): try await onControl(f)
                case let .complete(file, block, length, digest, data, received):
                    try await completeBlock(file: file, block: block, length: length, digest: digest, data: data, received: received)
                }
            } catch let e as ProtocolError {
                fail(ErrorCode.protocol, fatal: true, message: e.message)
            } catch let e as StorageFullError {
                fail(ErrorCode.storageFull, fatal: true, message: e.message)
            } catch {
                fail(ErrorCode.storageError, fatal: true, message: describe(error))
            }
        }
    }

    /// Call once the channel is open.
    public func start() {
        if let hello = try? Frame.json(.hello, o.hello) { send(hello) }
    }

    public func verifiedBytes(file: Int) -> Int64 {
        guard let t = files[file] else { return 0 }
        var n: Int64 = 0
        for i in 0 ..< t.prep.bitmap.size where t.prep.bitmap.has(i) {
            n += Int64(Wire.blockLength(size: t.entry.size, index: i, blockSize: t.entry.blockSize))
        }
        return n
    }

    public func pause() {
        if isPaused || closed { return }
        isPaused = true
        send(Frame.encode(.pause))
        o.events.onPaused(byPeer: false)
    }

    public func resume() {
        if !isPaused || closed { return }
        isPaused = false
        send(Frame.encode(.resume))
        o.events.onResumed(byPeer: false)
    }

    public func cancel() { fail(ErrorCode.cancelled, fatal: true, message: "Cancelled by the receiver.") }

    public func close() {
        closed = true
        work.finish()
        o.channel.close()
    }

    /// The receiver is going away: send nothing more.
    public func mute() { muted = true }

    private func send(_ buf: [UInt8]) {
        if closed || muted || !o.channel.isOpen { return }
        o.channel.send(buf)
    }

    private func fail(_ code: String, fatal: Bool, message: String?) {
        if let frame = try? Frame.json(.error, ErrorBody(code: code, fatal: fatal, message: message)) { send(frame) }
        end(code, fatal: fatal, message: message)
        if fatal, !muted {
            let channel = o.channel, drain = self.drain
            Task {
                await drain.until(channel, low: 0)
                try? await Task.sleep(nanoseconds: 100_000_000)
                channel.close()
            }
        }
    }

    private func end(_ code: String, fatal: Bool, message: String?) {
        if closed, code == ErrorCode.closed { return }
        closed = closed || fatal || code == ErrorCode.closed
        if closed { work.finish() }
        o.events.onError(code: code, fatal: fatal, message: message)
    }

    private func onFrame(_ data: [UInt8]) {
        let f: Frame
        do {
            f = try Frame.decode(data)
        } catch {
            fail(ErrorCode.protocol, fatal: true, message: describe(error))
            return
        }
        if f.type == .block {
            do {
                try onBlockFrame(f)
            } catch {
                fail(ErrorCode.protocol, fatal: true, message: describe(error))
            }
            return
        }
        work.yield(.control(f))
    }

    private func onControl(_ f: Frame) async throws {
        switch f.type {
        case .hello:
            let h = try f.body(HelloBody.self)
            guard h.v == 1, h.role == "sender", h.sessionId == o.hello.sessionId else { throw ProtocolError("bad HELLO") }
            authorized = true
        case .fileMeta:
            guard authorized else { throw ProtocolError("FILE_META before HELLO") }
            let meta = try f.body(FileMeta.self)
            for e in meta.files where e.blockSize <= 0 || e.size < 0 || e.blockCount != Wire.blockCount(
                size: e.size,
                blockSize: e.blockSize
            ) {
                throw ProtocolError("inconsistent FILE_META")
            }
            o.events.onMeta(files: meta.files)
            for entry in meta.files {
                let prep = try await o.prepare(entry)
                guard prep.bitmap.size == entry.blockCount else { throw ProtocolError("stored bitmap does not match the file") }
                files[entry.file] = Target(entry: entry, prep: prep)
                if prep.verified { done.insert(entry.file) }
                send(Frame.encode(.bitmap, file: UInt32(entry.file), payload: prep.bitmap.bytes))
                o.events.onProgress(file: entry.file, verifiedBytes: verifiedBytes(file: entry.file))
            }
        case .done:
            try await verifyFile(f.fileIndex, expected: f.body(DoneBody.self).sha256)
        case .pause:
            isPaused = true
            o.events.onPaused(byPeer: true)
        case .resume:
            isPaused = false
            o.events.onResumed(byPeer: true)
        case .error:
            let e = try f.body(ErrorBody.self)
            end(e.code, fatal: e.fatal, message: e.message)
            if e.fatal { close() }
        default:
            throw ProtocolError("unexpected frame \(f.type.rawValue) from a sender")
        }
    }

    private func onBlockFrame(_ f: Frame) throws {
        let key = BlockKey(file: f.fileIndex, block: f.block)
        guard let target = files[f.fileIndex] else { throw ProtocolError("block for unknown file \(f.fileIndex)") }
        guard f.block < target.entry.blockCount else { throw ProtocolError("block \(f.block) outside the file") }
        let len = Wire.blockLength(size: target.entry.size, index: f.block, blockSize: target.entry.blockSize)
        var start = 0
        if f.isFirst {
            guard f.offset == 0, assembling[key] == nil else { throw ProtocolError("unexpected first frame") }
            guard assembling.count < o.maxAssembling else { throw ProtocolError("too many blocks in flight") }
            assembling[key] = Assembly(digest: Array(f.payload[0 ..< Wire.digestBytes]), data: [UInt8](repeating: 0, count: len))
            start = Wire.digestBytes
        }
        let n = f.payload.count - start
        guard let a = assembling[key], f.offset == a.received, f.offset + n <= len else { throw ProtocolError("block frame out of place") }
        assembling[key]!.data.replaceSubrange(f.offset ..< f.offset + n, with: f.payload[start...])
        assembling[key]!.received += n
        guard f.isLast else { return }
        let complete = assembling.removeValue(forKey: key)!
        work.yield(.complete(
            file: f.fileIndex,
            block: f.block,
            length: len,
            digest: complete.digest,
            data: complete.data,
            received: complete.received
        ))
    }

    private func completeBlock(file: Int, block: Int, length: Int, digest: [UInt8], data: [UInt8], received: Int) async throws {
        guard let t = files[file] else { throw ProtocolError("block for unknown file \(file)") }
        counters.blocksReceived += 1
        if t.prep.bitmap.has(block) {
            counters.duplicates += 1
            send(Frame.encode(.ack, file: UInt32(file), block: block))
            return
        }
        if received != length { return nack(file: file, block: block, reason: "length") }
        if !equalBytes(sha256(data), digest) { return nack(file: file, block: block, reason: "checksum") }
        try await t.prep.sink.write(offset: Int64(block) * Int64(t.entry.blockSize), data)
        try await t.prep.sink.flush()
        files[file]!.prep.bitmap.set(block)
        try await t.prep.persist(files[file]!.prep.bitmap)
        send(Frame.encode(.ack, file: UInt32(file), block: block)) // only after write + verify + persist
        o.events.onProgress(file: file, verifiedBytes: verifiedBytes(file: file))
    }

    private func nack(file: Int, block: Int, reason: String) {
        counters.nacksSent += 1
        if let frame = try? Frame.json(.nack, NackBody(reason: reason), file: UInt32(file), block: block) { send(frame) }
    }

    private func verifyFile(_ file: Int, expected: String) async throws {
        guard let t = files[file] else { throw ProtocolError("DONE for unknown file \(file)") }
        guard t.prep.bitmap.isFull else { throw ProtocolError("DONE before every block was verified") }
        if done.contains(file) {
            try send(Frame.json(.done, DoneBody(sha256: expected, ok: true), file: UInt32(file)))
            finish(file)
            return
        }
        let sink = t.prep.sink, events = o.events
        let actual = try await hashStream(
            size: t.entry.size,
            read: { try await sink.read(offset: $0, length: $1) },
            onProgress: { events.onVerifying(file: file, hashedBytes: $0) }
        )
        let ok = actual == expected
        try send(Frame.json(.done, DoneBody(sha256: actual, ok: ok), file: UInt32(file)))
        if !ok {
            fail(ErrorCode.fileHashMismatch, fatal: true, message: "The received file does not match the sender’s file.")
            o.events.onFileDone(file: file, ok: false)
            return
        }
        finish(file)
    }

    private func finish(_ file: Int) {
        done.insert(file)
        o.events.onFileDone(file: file, ok: true)
        if done.count == files.count { o.events.onComplete() }
    }
}
