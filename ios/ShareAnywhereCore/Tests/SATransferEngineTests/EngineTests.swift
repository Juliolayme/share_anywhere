import Foundation
@testable import SATransferEngine
import XCTest

/// End-to-end engine behaviour over an in-memory channel (docs/TRANSFER_PROTOCOL.md §3–§5), as the Web's engine.test.ts
/// and Android's EngineTest.
final class EngineTests: XCTestCase {
    let bs = 64 * 1024

    struct Link {
        let pair: (MemChannel, MemChannel)
        let tx: Recorder
        let rx: Recorder
        let store: RxStore
        let sender: SenderConnection
        let receiver: ReceiverConnection
    }

    func link(
        _ data: [[UInt8]], store: RxStore = RxStore(), capabilityOk: Bool = true, cache: BlockCache? = nil,
        hashes: [Int: FileHash]? = nil, corrupt: Int = 0, sources: [any FileSource]? = nil, max: Int? = 65536,
        failWritesAfter: Int? = nil
    ) -> Link {
        let pair = MemChannel.pair(max: max)
        let tx = Recorder(), rx = Recorder()
        let srcs = sources ?? data.map { MemorySource($0) }
        let files = srcs.enumerated().map { i, s in
            SenderFile(
                index: i,
                fileId: "f\(i)",
                transferId: "t\(i)",
                name: "file\(i).bin",
                size: s.size,
                mime: "application/octet-stream",
                source: s
            )
        }
        var so = SenderOptions(
            channel: pair.0, sessionId: "s1", files: files,
            hashes: hashes ?? Dictionary(uniqueKeysWithValues: files.map { ($0.index, FileHash(source: $0.source)) }),
            authorize: { pid, cap in capabilityOk && pid == "p1" && cap == "cap" }, events: TxEvents(r: tx), cache: cache
        )
        so.blockSize = bs
        so.corruptBlocks = corrupt
        let ro = ReceiverOptions(
            channel: pair.1, hello: HelloReceiver(sessionId: "s1", participantId: "p1", capability: "cap"),
            prepare: { e in
                let mem = await store.sink(e.file, size: e.size)
                let sink: any Sink = failWritesAfter.map { FullDisk(inner: mem, okWrites: $0) } ?? mem
                let bm = await store.bitmap(e.file) ?? Bitmap(size: e.blockCount)
                return PreparedFile(sink: sink, bitmap: bm, persist: { b in await store.persist(e.file, b) })
            },
            events: RxEvents(r: rx)
        )
        return Link(pair: pair, tx: tx, rx: rx, store: store, sender: SenderConnection(so), receiver: ReceiverConnection(ro))
    }

    func bytes(_ l: Link, _ file: Int) async -> [UInt8] {
        guard let s = await l.store.sinks[file] else { return [] }
        return await s.bytes
    }

    func testFilesArriveVerifiedIncludingAnEmptyOneAndAPartialLastBlock() async throws {
        let data = [bytesOf(bs * 3 + 123, seed: 1), [], bytesOf(bs - 1, seed: 2)]
        let l = link(data)
        await l.receiver.start()
        try await until { l.rx.complete && l.tx.complete }
        for i in data.indices {
            let got = await bytes(l, i); XCTAssertEqual(got, data[i])
        }
        XCTAssertEqual(l.tx.authorized, "p1")
        let dup = await l.receiver.counters.duplicates
        XCTAssertEqual(dup, 0)
        XCTAssertEqual(l.rx.doneFiles.sorted { $0.0 < $1.0 }.map { "\($0.0):\($0.1)" }, ["0:true", "1:true", "2:true"])
        XCTAssertTrue(l.rx.errors.isEmpty && l.tx.errors.isEmpty, "\(l.rx.errors) \(l.tx.errors)")
    }

    func testAReconnectResumesOnlyTheMissingBlocks() async throws {
        let data = [bytesOf(bs * 10, seed: 3)]
        let store = RxStore()
        // An earlier connection verified blocks 0, 3 and 9 and persisted them.
        let sink = MemorySink(size: Int64(data[0].count))
        var bm = Bitmap(size: 10)
        for b in [0, 3, 9] {
            bm.set(b)
            await sink.put(at: b * bs, data[0][b * bs ..< (b + 1) * bs])
        }
        await store.setSink(0, sink)
        await store.persist(0, bm)
        let l = link(data, store: store)
        await l.receiver.start()
        try await until { l.rx.complete && l.tx.complete }
        let got = await bytes(l, 0)
        XCTAssertEqual(got, data[0])
        let sent = await l.sender.counters.blocksSent
        let resent = await l.sender.counters.verifiedResent
        let dup = await l.receiver.counters.duplicates
        XCTAssertEqual(sent, 7, "only the 7 missing blocks are sent")
        XCTAssertEqual(resent, 0)
        XCTAssertEqual(dup, 0)
    }

    func testACorruptBlockIsNackedAndSentAgain() async throws {
        let data = [bytesOf(bs * 4, seed: 4)]
        let l = link(data, corrupt: 2)
        await l.receiver.start()
        try await until { l.rx.complete && l.tx.complete }
        let got = await bytes(l, 0)
        XCTAssertEqual(got, data[0])
        let nacks = await l.sender.counters.nacks
        let sentNacks = await l.receiver.counters.nacksSent
        XCTAssertEqual(nacks, 2)
        XCTAssertEqual(sentNacks, 2)
    }

    func testRepeatedChecksumFailuresEndTheTransfer() async throws {
        let l = link([bytesOf(bs * 2, seed: 5)], corrupt: 10)
        await l.receiver.start()
        try await until { l.tx.errors.contains(ErrorCode.checksumRetries) && l.rx.errors.contains(ErrorCode.checksumRetries) }
        XCTAssertFalse(l.rx.complete)
    }

    /// Phase 9 lifecycle: the device fills up while receiving; both sides end with storage_full.
    func testStorageFullOnTheReceiverEndsBothSidesWithStorageFull() async throws {
        let l = link([bytesOf(bs * 8, seed: 21)], failWritesAfter: 2)
        await l.receiver.start()
        try await until { l.rx.errors.contains(ErrorCode.storageFull) && l.tx.errors.contains(ErrorCode.storageFull) }
        XCTAssertFalse(l.rx.complete)
    }

    /// Phase 9 lifecycle: the picked file becomes unreadable mid-send (security-scoped bookmark invalidated, file
    /// moved or deleted); both sides end with file_unreadable.
    func testASourceThatBecomesUnreadableMidSendEndsBothSidesWithFileUnreadable() async throws {
        let data = bytesOf(bs * 8, seed: 22)
        let l = link([data], hashes: [0: FileHash(source: MemorySource(data))], sources: [RevokedSource(data, okReads: 3)])
        await l.receiver.start()
        try await until { l.tx.errors.contains(ErrorCode.fileUnreadable) && l.rx.errors.contains(ErrorCode.fileUnreadable) }
    }

    func testAReceiverWithoutTheCapabilityIsRefused() async throws {
        let l = link([bytesOf(bs, seed: 6)], capabilityOk: false)
        await l.receiver.start()
        try await until { l.rx.errors.contains(ErrorCode.unauthorized) }
        XCTAssertNil(l.tx.authorized)
        let sent = await l.sender.counters.blocksSent
        XCTAssertEqual(sent, 0)
    }

    func testAFileThatChangedSinceItWasHashedFailsTheWholeFileCheck() async throws {
        let sent = bytesOf(bs * 3, seed: 7)
        var changed = sent
        changed[bs + 5] &+= 1
        // The whole-file hash was taken over the earlier contents (a sequential pass that ran before the edit).
        let stale = FileHash(source: MemorySource(changed))
        _ = try await stale.value()
        let l = link([sent], hashes: [0: stale])
        await l.receiver.start()
        try await until { l.rx.errors.contains(ErrorCode.fileHashMismatch) && !l.rx.doneFiles.isEmpty }
        XCTAssertEqual(l.rx.doneFiles.map { "\($0.0):\($0.1)" }, ["0:false"])
        XCTAssertFalse(l.rx.complete)
    }

    func testPauseStopsNewBlocksAndResumeContinues() async throws {
        let data = [bytesOf(bs * 40, seed: 8)]
        let l = link(data)
        l.pair.0.delayMs = 1
        await l.receiver.start()
        try await until { await l.sender.counters.blocksSent >= 2 }
        await l.receiver.pause()
        try await until { await l.sender.isPaused }
        try await Task.sleep(nanoseconds: 150_000_000)
        let whilePaused = await l.sender.counters.blocksSent
        try await Task.sleep(nanoseconds: 150_000_000)
        let later = await l.sender.counters.blocksSent
        XCTAssertLessThanOrEqual(later, whilePaused + 4, "at most the in-flight window completes while paused")
        XCTAssertLessThan(later, 40)
        await l.receiver.resume()
        try await until(60) { l.rx.complete && l.tx.complete }
        let got = await bytes(l, 0)
        XCTAssertEqual(got, data[0])
    }

    func testThreeReceiversShareOneBlockCacheAndReadTheFileOnce() async throws {
        let data = bytesOf(bs * 8, seed: 9)
        let cache = BlockCache(maxBytes: 64 * 1024 * 1024)
        let source = MemorySource(data)
        let shared = [0: FileHash(source: source)]
        let links = (1 ... 3).map { _ in link([data], cache: cache, hashes: shared, sources: [source]) }
        for l in links {
            await l.receiver.start()
        }
        try await until { links.allSatisfy { $0.rx.complete && $0.tx.complete } }
        for l in links {
            let got = await bytes(l, 0); XCTAssertEqual(got, data)
        }
        let reads = await cache.reads
        XCTAssertEqual(reads, 8, "each block read once for all receivers")
        XCTAssertEqual(source.reads, 8)
    }

    func testSmallMessageLimitsSplitBlocksIntoMoreFrames() async throws {
        let data = [bytesOf(bs * 2 + 5, seed: 10)]
        let l = link(data, max: 16384)
        await l.receiver.start()
        try await until { l.rx.complete && l.tx.complete }
        let got = await bytes(l, 0)
        XCTAssertEqual(got, data[0])
    }

    func testDrainWakesEveryWaiter() async throws {
        let (a, _) = MemChannel.pair()
        let drain = Drain()
        // Nothing buffered: returns at once.
        await drain.until(a, low: 0)
        drain.signal()
    }
}
