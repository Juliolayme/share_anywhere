import Foundation

/// A file the sender reads in slices; never loaded whole.
public protocol FileSource: Sendable {
    var size: Int64 { get }
    /// Exactly `length` bytes at `offset` (fewer when the file shrank); throws when the file cannot be read.
    func read(offset: Int64, length: Int) async throws -> [UInt8]
}

public struct SenderFile: Sendable {
    public let index: Int
    public let fileId: String
    public let transferId: String
    public let name: String
    public let size: Int64
    public let mime: String
    public let source: any FileSource

    public init(index: Int, fileId: String, transferId: String, name: String, size: Int64, mime: String, source: any FileSource) {
        self.index = index
        self.fileId = fileId
        self.transferId = transferId
        self.name = name
        self.size = size
        self.mime = mime
        self.source = source
    }
}

/// Whole-file SHA-256 shared by every connection to every receiver: fed in order while blocks are read for sending,
/// completed by one sequential pass when blocks went out of order.
public actor FileHash {
    private let source: any FileSource
    private var hasher = StreamHasher()
    private var result: Task<String, any Error>?

    public init(source: any FileSource) { self.source = source }

    public func feed(offset: Int64, _ data: [UInt8]) {
        if result == nil { hasher.update(offset: offset, data) }
    }

    public func value() async throws -> String {
        if let r = result { return try await r.value }
        let task = Task { try await self.finish() }
        result = task
        return try await task.value
    }

    private func finish() async throws -> String {
        while hasher.position < source.size {
            let off = hasher.position
            let data = try await source.read(offset: off, length: Int(min(Int64(Wire.blockSize), source.size - off)))
            if data.isEmpty { throw TransferIOError("The file changed while it was being sent.") }
            hasher.update(offset: off, data)
        }
        return hasher.hex()
    }
}

public struct SenderCounters: Sendable {
    public var blocksSent = 0
    public var verifiedResent = 0
    public var nacks = 0
    public var bytesSent: Int64 = 0
}

/// Engine callbacks, called from the connection's actor (hop to the main actor in the UI layer).
public protocol SenderEvents: Sendable {
    func onAuthorized(participantId: String)
    func onProgress(file: Int, verifiedBytes: Int64)
    func onFileDone(file: Int)
    func onComplete()
    func onPaused(byPeer: Bool)
    func onResumed(byPeer: Bool)
    func onError(code: String, fatal: Bool, message: String?)
}

public extension SenderEvents {
    func onAuthorized(participantId _: String) {}
    func onProgress(file _: Int, verifiedBytes _: Int64) {}
    func onFileDone(file _: Int) {}
    func onComplete() {}
    func onPaused(byPeer _: Bool) {}
    func onResumed(byPeer _: Bool) {}
    func onError(code _: String, fatal _: Bool, message _: String?) {}
}

public struct NoSenderEvents: SenderEvents { public init() {} }

public struct SenderOptions: Sendable {
    public var channel: any TransferChannel
    public var sessionId: String
    public var files: [SenderFile]
    public var hashes: [Int: FileHash]
    public var authorize: @Sendable (_ participantId: String, _ capability: String) async -> Bool
    public var events: any SenderEvents
    public var cache: BlockCache?
    public var window = 4
    public var highWater = 8 * 1024 * 1024
    public var lowWater = 1024 * 1024
    public var maxRetries = 3
    /// The sender no longer has the files: authorize, then end with file_unreadable.
    public var unavailable = false
    public var blockSize = Wire.blockSize
    /// Test hook: corrupt this many upcoming blocks after hashing them.
    public var corruptBlocks = 0

    public init(
        channel: any TransferChannel, sessionId: String, files: [SenderFile], hashes: [Int: FileHash],
        authorize: @escaping @Sendable (String, String) async -> Bool, events: any SenderEvents = NoSenderEvents(), cache: BlockCache? = nil
    ) {
        self.channel = channel
        self.sessionId = sessionId
        self.files = files
        self.hashes = hashes
        self.authorize = authorize
        self.events = events
        self.cache = cache
    }
}

private struct BlockKey: Hashable, Sendable {
    let file: Int
    let block: Int
}

/// One sender ↔ receiver connection (docs/TRANSFER_PROTOCOL.md §3–§5), the Swift twin of the Web's SenderConnection
/// and Android's `SenderConnection`. Create a new one per (re)connect. Frames are handled one at a time in arrival
/// order; the block pump runs as its own task so it can wait for the channel buffer to drain.
public actor SenderConnection {
    private let o: SenderOptions
    public private(set) var counters = SenderCounters()
    public private(set) var participantId: String?
    public private(set) var isPaused = false
    private var bitmaps: [Int: Bitmap] = [:]
    private var queue: [BlockKey] = []
    private var inflight = Set<BlockKey>()
    private var retries: [BlockKey: Int] = [:]
    private var doneSent = Set<Int>()
    private var confirmed = Set<Int>()
    private var pumping = false
    private var closed = false
    private var corruptBlocks: Int
    private let frameData: Int
    private let drain = Drain()

    public init(_ options: SenderOptions) {
        o = options
        corruptBlocks = options.corruptBlocks
        frameData = Wire.dataPerFrame(maxMessageSize: options.channel.maxMessageSize)
        let (stream, continuation) = makeStream(of: ChannelEvent.self)
        options.channel.setListener(ChannelInbox(continuation, drain))
        Task { await self.run(stream) }
    }

    private func run(_ stream: AsyncStream<ChannelEvent>) async {
        for await event in stream {
            switch event {
            case let .message(data): await onFrame(data)
            case .closed: end(ErrorCode.closed, fatal: false, message: nil)
            }
        }
    }

    public func verifiedBytes(file: Int) -> Int64 {
        guard let bm = bitmaps[file], let f = o.files.first(where: { $0.index == file }) else { return 0 }
        var n: Int64 = 0
        for i in 0 ..< bm.size where bm.has(i) {
            n += Int64(Wire.blockLength(size: f.size, index: i, blockSize: o.blockSize))
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
        startPump()
    }

    public func cancel() { fail(ErrorCode.cancelled, fatal: true, message: "Cancelled by the sender.") }

    public func close() {
        closed = true
        o.channel.close()
    }

    private func send(_ buf: [UInt8]) {
        if closed || !o.channel.isOpen { return }
        o.channel.send(buf)
    }

    private func fail(_ code: String, fatal: Bool, message: String?) {
        if let frame = try? Frame.json(.error, ErrorBody(code: code, fatal: fatal, message: message)) { send(frame) }
        end(code, fatal: fatal, message: message)
        if fatal {
            let channel = o.channel, drain = self.drain, low = o.lowWater
            Task {
                await drain.until(channel, low: low)
                try? await Task.sleep(nanoseconds: 100_000_000)
                channel.close()
            }
        }
    }

    private func end(_ code: String, fatal: Bool, message: String?) {
        if closed, code == ErrorCode.closed { return }
        closed = closed || fatal || code == ErrorCode.closed
        o.events.onError(code: code, fatal: fatal, message: message)
    }

    private func onFrame(_ data: [UInt8]) async {
        do {
            let f = try Frame.decode(data)
            switch f.type {
            case .hello: try await onHello(f.body(HelloBody.self))
            case .bitmap: try await onBitmap(file: f.fileIndex, f.payload)
            case .ack: try await onAck(file: f.fileIndex, block: f.block)
            case .nack:
                _ = try f.body(NackBody.self)
                try onNack(file: f.fileIndex, block: f.block)
            case .done:
                let body = try f.body(DoneBody.self)
                if body.ok == true {
                    confirmed.insert(f.fileIndex)
                    o.events.onFileDone(file: f.fileIndex)
                    if confirmed.count == o.files.count { o.events.onComplete() }
                }
            case .pause:
                isPaused = true
                o.events.onPaused(byPeer: true)
            case .resume:
                isPaused = false
                o.events.onResumed(byPeer: true)
                startPump()
            case .error:
                let e = try f.body(ErrorBody.self)
                end(e.code, fatal: e.fatal, message: e.message)
                if e.fatal { close() }
            default:
                throw ProtocolError("unexpected frame \(f.type.rawValue) from a receiver")
            }
        } catch {
            fail(ErrorCode.protocol, fatal: true, message: describe(error))
        }
    }

    private func onHello(_ h: HelloBody) async throws {
        guard h.v == 1, h.role == "receiver", h.sessionId == o.sessionId,
              let pid = h.participantId, !pid.isEmpty, let cap = h.capability, !cap.isEmpty
        else { throw ProtocolError("bad HELLO") }
        guard await o.authorize(pid, cap) else {
            fail(ErrorCode.unauthorized, fatal: true, message: "This device is not a joined receiver of the session.")
            return
        }
        participantId = pid
        if o.unavailable {
            fail(ErrorCode.fileUnreadable, fatal: true, message: "The sender no longer has these files.")
            return
        }
        o.events.onAuthorized(participantId: pid)
        try send(Frame.json(.hello, HelloSender(sessionId: o.sessionId)))
        let meta = FileMeta(files: o.files.map {
            FileMetaEntry(
                file: $0.index, fileId: $0.fileId, transferId: $0.transferId, name: $0.name, size: $0.size, mime: $0.mime,
                blockSize: o.blockSize, blockCount: Wire.blockCount(size: $0.size, blockSize: o.blockSize)
            )
        })
        try send(Frame.json(.fileMeta, meta))
    }

    private func onBitmap(file: Int, _ bytes: [UInt8]) async throws {
        guard participantId != nil, let f = o.files.first(where: { $0.index == file }) else {
            throw ProtocolError("BITMAP before HELLO or for an unknown file")
        }
        let bm = try Bitmap(size: Wire.blockCount(size: f.size, blockSize: o.blockSize), bytes: bytes)
        bitmaps[file] = bm
        for block in bm.missing() {
            queue.append(BlockKey(file: file, block: block))
        }
        o.events.onProgress(file: file, verifiedBytes: verifiedBytes(file: file))
        if bitmaps.count == o.files.count {
            queue.sort { ($0.file, $0.block) < ($1.file, $1.block) }
            for x in o.files {
                await maybeDone(x.index)
            }
            startPump()
        }
    }

    private func onAck(file: Int, block: Int) async throws {
        let key = BlockKey(file: file, block: block)
        guard bitmaps[file] != nil, inflight.remove(key) != nil else {
            throw ProtocolError("ACK for block \(file):\(block) that is not in flight")
        }
        guard block < bitmaps[file]!.size else { throw ProtocolError("ACK for block \(file):\(block) outside the file") }
        bitmaps[file]!.set(block)
        o.events.onProgress(file: file, verifiedBytes: verifiedBytes(file: file))
        await maybeDone(file)
        startPump()
    }

    private func onNack(file: Int, block: Int) throws {
        let key = BlockKey(file: file, block: block)
        guard inflight.remove(key) != nil else { throw ProtocolError("NACK for block \(file):\(block) that is not in flight") }
        counters.nacks += 1
        let n = (retries[key] ?? 0) + 1
        retries[key] = n
        if n > o.maxRetries {
            fail(ErrorCode.checksumRetries, fatal: true, message: "Block \(block) failed verification \(n) times.")
            return
        }
        queue.insert(key, at: 0)
        startPump()
    }

    private func maybeDone(_ file: Int) async {
        guard let bm = bitmaps[file], bm.isFull, !doneSent.contains(file) else { return }
        doneSent.insert(file)
        guard let hash = o.hashes[file] else {
            fail(ErrorCode.protocol, fatal: true, message: "no hash state for file \(file)")
            return
        }
        do {
            let sum = try await hash.value()
            try send(Frame.json(.done, DoneBody(sha256: sum), file: UInt32(file)))
        } catch {
            fail(ErrorCode.fileUnreadable, fatal: true, message: describe(error))
        }
    }

    private func startPump() {
        Task { await self.pump() }
    }

    /// Sends queued blocks while the window and the channel buffer allow.
    private func pump() async {
        if pumping { return }
        pumping = true
        defer { pumping = false }
        do {
            while !closed, !isPaused, inflight.count < o.window, !queue.isEmpty {
                let job = queue.removeFirst()
                if bitmaps[job.file]?.has(job.block) == true {
                    counters.verifiedResent += 1
                    continue
                }
                try await sendBlock(job)
            }
        } catch let e as ProtocolError {
            fail(ErrorCode.protocol, fatal: true, message: e.message)
        } catch {
            fail(ErrorCode.fileUnreadable, fatal: true, message: describe(error))
        }
    }

    private func sendBlock(_ job: BlockKey) async throws {
        guard let f = o.files.first(where: { $0.index == job.file }) else { throw ProtocolError("unknown file \(job.file)") }
        let len = Wire.blockLength(size: f.size, index: job.block, blockSize: o.blockSize)
        let offset = Int64(job.block) * Int64(o.blockSize)
        let hash = o.hashes[job.file]
        let source = f.source
        let load: @Sendable () async throws -> [UInt8] = {
            let read = try await source.read(offset: offset, length: len)
            if read.count != len { throw TransferIOError("The file changed while it was being sent.") }
            await hash?.feed(offset: offset, read)
            return read
        }
        let cached: CachedBlock
        if let cache = o.cache {
            cached = try await cache.get(file: job.file, block: job.block, load: load)
        } else {
            let data = try await load()
            cached = CachedBlock(data: data, sum: sha256(data))
        }
        var data = cached.data
        if corruptBlocks > 0, !data.isEmpty {
            corruptBlocks -= 1
            data[0] ^= 0xFF
        }
        inflight.insert(job)
        var off = 0
        while true {
            if closed { return }
            if o.channel.bufferedAmount > o.highWater { await drain.until(o.channel, low: o.lowWater) }
            if closed { return }
            let first = off == 0
            let room = frameData - (first ? Wire.digestBytes : 0)
            let n = min(room, len - off)
            let last = off + n >= len
            var payload = [UInt8]()
            payload.reserveCapacity((first ? Wire.digestBytes : 0) + n)
            if first { payload.append(contentsOf: cached.sum) }
            payload.append(contentsOf: data[off ..< off + n])
            send(Frame.encode(
                .block, flags: (first ? Wire.flagFirst : 0) | (last ? Wire.flagLast : 0), file: UInt32(job.file),
                block: job.block, offset: off, payload: payload
            ))
            counters.bytesSent += Int64(n)
            off += n
            if last { break }
        }
        counters.blocksSent += 1
    }
}
