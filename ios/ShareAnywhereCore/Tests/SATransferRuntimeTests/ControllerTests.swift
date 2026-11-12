import Crypto
import Foundation
import SAStore
@testable import SATransferRuntime
import XCTest

/// Sender and receiver controllers end to end over the fake backend and in-memory peers: open join, receive into a
/// folder with sidecar bitmaps, pause and resume, a dropped connection resumed without duplicate blocks, cancel, and
/// History on both sides.
final class ControllerTests: XCTestCase {
    var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("sa-rt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    struct Rig {
        let backend: FakeBackend
        let peers: MemPeerFactory
        let sessionId: String
        let sender: SenderController
        let receiver: ReceiverController
        let senderHistory: HistoryStore
        let receiverHistory: HistoryStore
        let inbox: URL
        let sums: [String]
        let receiverPid: String
    }

    func file(_ name: String, _ size: Int) throws -> (URL, String) {
        var bytes = [UInt8](repeating: 0, count: size)
        var x: UInt32 = 2_463_534_242
        for i in 0 ..< size {
            x ^= x << 13
            x ^= x >> 17
            x ^= x << 5
            bytes[i] = UInt8(truncatingIfNeeded: x)
        }
        let url = dir.appendingPathComponent(name)
        try Data(bytes).write(to: url)
        return (url, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    }

    func rig(
        sizes: [Int], delayMs: UInt64 = 0, fastClock: Bool = false, keepFiles: Bool = true, routeConfig: MonitorConfig = MonitorConfig(),
        cloud: Bool = false
    ) async throws -> Rig {
        let backend = FakeBackend()
        let peers = MemPeerFactory()
        peers.delayMs = delayMs
        var files: [(URL, String)] = []
        for (i, n) in sizes.enumerated() {
            try files.append(file("f\(i).bin", n))
        }
        let sid = backend.createSession(device: "dev-s", files: files.indices.map { ("f\($0).bin", Int64(sizes[$0])) })
        let shared = try backend.view(sid, device: "dev-s").files!
        let outgoing = JSONMap<[OutgoingFile]>(url: dir.appendingPathComponent("outgoing.json"))
        if keepFiles { try await outgoing.put(
            sid,
            zip(shared, files).map { OutgoingFile(fileId: $0.id, size: $0.size, locator: Data($1.0.path.utf8)) }
        ) }
        let pid = backend.join(sid, device: "dev-r", name: "Receiver iPad")
        let fast: Sleeper = { ms in try? await Task.sleep(nanoseconds: UInt64(max(1, ms / (fastClock ? 100 : 1))) * 1_000_000) }
        let sClient = backend.client("dev-s"), rClient = backend.client("dev-r")
        let sSocket = SessionSocket(baseURL: URL(string: "http://fake")!, connector: sClient, ticket: { "t" }, pause: { _ in })
        let rSocket = SessionSocket(baseURL: URL(string: "http://fake")!, connector: rClient, ticket: { "t" }, pause: { _ in })
        let sh = try HistoryStore(path: dir.appendingPathComponent("s.sqlite").path)
        let rh = try HistoryStore(path: dir.appendingPathComponent("r.sqlite").path)
        var sDeps = SenderDeps(
            sessionId: sid, sessions: sClient, transfers: sClient, socket: sSocket, peers: peers, outgoing: outgoing, history: sh,
            openSource: { f in FileReadSource(url: URL(fileURLWithPath: String(decoding: f.locator, as: UTF8.self)), size: f.size) },
            sleep: fast
        )
        if cloud { sDeps.cloud = sClient }
        let sender = SenderController(sDeps)
        let inbox = dir.appendingPathComponent("Inbox")
        var rDeps = ReceiverDeps(
            sessionId: sid, sessions: rClient, transfers: rClient, socket: rSocket, peers: peers,
            targets: JSONMap(url: dir.appendingPathComponent("targets.json")),
            saved: JSONMap(url: dir.appendingPathComponent("saved.json")),
            history: rh, resolveFolder: { _ in ScopedFolder(url: inbox) }, sleep: fast, random: { 0.5 }
        )
        rDeps.routeConfig = routeConfig
        if cloud { rDeps.cloud = rClient }
        let receiver = ReceiverController(rDeps)
        return Rig(
            backend: backend, peers: peers, sessionId: sid, sender: sender, receiver: receiver, senderHistory: sh, receiverHistory: rh,
            inbox: inbox,
            sums: files.map(\.1), receiverPid: pid
        )
    }

    func until(_ what: String, timeout: TimeInterval = 30, _ check: @escaping () async -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if await check() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what)")
        throw FakeError()
    }

    func entry(_ h: HistoryStore, _ id: String) async -> SAStore.HistoryEntry? { await (try? h.get(id)) ?? nil }

    func sha(_ url: URL) throws -> String {
        try SHA256.hash(data: Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }

    func testOpenJoinReceiveCompletesWithVerifiedFilesAndHistory() async throws {
        let r = try await rig(sizes: [9 * 1024 * 1024 + 17, 1000, 0])
        await r.sender.start()
        await r.sender.loaded()
        XCTAssertTrue(r.sender.state.value.hasFiles)
        XCTAssertEqual(r.sender.state.value.receivers.map(\.status), [.waiting])

        await r.receiver.start()
        await r.receiver.loaded()
        XCTAssertEqual(r.receiver.state.value.phase, .choose, "first receive asks where to save")
        XCTAssertEqual(r.receiver.state.value.words, ["amber", "breeze", "cedar"])
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))

        try await until("receiver completed") { r.receiver.state.value.phase == .completed }
        let files = r.receiver.state.value.files
        XCTAssertEqual(files.count, 3)
        for (f, sum) in zip(files, r.sums) {
            let url = try XCTUnwrap(f.savedURL, "saved \(f.name)")
            XCTAssertEqual(url.lastPathComponent, f.name)
            XCTAssertEqual(try sha(url), sum)
        }
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: r.inbox.path).filter { $0.hasPrefix(".sa-") }
        XCTAssertEqual(leftovers, [], "no partial files or sidecars after completion")
        try await until("server transfers completed") { r.backend.transfers(r.sessionId).allSatisfy { $0.status == "COMPLETED" } }
        XCTAssertTrue(r.backend.rejectedReports.isEmpty, "every report is a valid transition: \(r.backend.rejectedReports)")
        try await until("sender completed") { r.sender.state.value.final == .completed }
        XCTAssertEqual(r.sender.state.value.receivers.first?.route, "direct")

        try await until("history") {
            let tx = await self.entry(r.senderHistory, "tx:\(r.sessionId)")
            let rx = await self.entry(r.receiverHistory, "rx:\(r.sessionId)")
            return tx?.status == .completed && rx?.status == .completed
        }
        let rxEntry = await entry(r.receiverHistory, "rx:\(r.sessionId)")
        let rx = try XCTUnwrap(rxEntry)
        XCTAssertEqual(rx.direction, .received)
        XCTAssertEqual(rx.peer, "Sender iPhone")
        XCTAssertEqual(rx.fileCount, 3)
        let txEntry = await entry(r.senderHistory, "tx:\(r.sessionId)")
        let tx = try XCTUnwrap(txEntry)
        XCTAssertEqual(tx.peers, ["Receiver iPad"])
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    func testAHelloThatArrivesBeforeTheSenderIsReadyIsNotLost() async throws {
        let r = try await rig(sizes: [5000])
        r.peers.announceDelayMs = 150
        await r.sender.start()
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("completed although the receiver spoke first", timeout: 15) { r.receiver.state.value.phase == .completed }
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    func testPauseAndResumeFromTheReceiver() async throws {
        let r = try await rig(sizes: [24 * 1024 * 1024], delayMs: 2)
        await r.sender.start()
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("bytes moving") { r.receiver.state.value.verified > 0 }
        await r.receiver.pause()
        XCTAssertEqual(r.receiver.state.value.phase, .paused)
        try await until("server paused") { r.backend.transfers(r.sessionId).allSatisfy { $0.status == "PAUSED" } }
        try await until("sender sees paused") { r.sender.state.value.receivers.first?.status == .paused }
        let atPause = r.receiver.state.value.verified
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertLessThanOrEqual(r.receiver.state.value.verified, atPause + Int64(Wire.blockSize) * 4, "at most the in-flight window")

        await r.receiver.resume()
        try await until("completed after resume", timeout: 60) { r.receiver.state.value.phase == .completed }
        XCTAssertEqual(try sha(XCTUnwrap(r.receiver.state.value.files[0].savedURL)), r.sums[0])
        XCTAssertTrue(r.backend.rejectedReports.isEmpty, "\(r.backend.rejectedReports)")
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    func testADroppedConnectionResumesWithoutResendingVerifiedBlocks() async throws {
        let r = try await rig(sizes: [40 * 1024 * 1024], delayMs: 1, fastClock: true)
        await r.sender.start()
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("three blocks verified") { r.receiver.state.value.verified >= Int64(Wire.blockSize) * 3 }
        let before = r.peers.count
        r.peers.severAll()
        try await until("reconnecting") { r.receiver.state.value.phase == .reconnecting || r.peers.count > before }
        try await until("completed after reconnect", timeout: 90) { r.receiver.state.value.phase == .completed }
        XCTAssertGreaterThan(r.peers.count, before, "a new peer connection was dialled")
        XCTAssertEqual(r.receiver.state.value.duplicates, 0, "verified blocks are not sent again")
        XCTAssertEqual(try sha(XCTUnwrap(r.receiver.state.value.files[0].savedURL)), r.sums[0])
        XCTAssertTrue(r.backend.log.contains { $0.hasSuffix(":DISCONNECTED") }, "the drop was reported")
        XCTAssertTrue(r.backend.rejectedReports.isEmpty, "\(r.backend.rejectedReports)")
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    /// Route strategy (docs/ARCHITECTURE.md §6): the direct path stops carrying data mid-transfer; the stall moves the
    /// receiver one policy step stricter (relay-only over UDP TURN URIs), the transfer resumes from the bitmap without
    /// duplicate blocks, and both ends show the relay.
    func testAStalledDirectPathMigratesToTheRelayAndResumes() async throws {
        var cfg = MonitorConfig()
        cfg.stallMs = 600
        cfg.cooldownMs = 5000
        let r = try await rig(sizes: [24 * 1024 * 1024], delayMs: 1, fastClock: true, routeConfig: cfg)
        await r.sender.start()
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("direct route classified") { r.receiver.state.value.routeKind == .direct }
        try await until("three blocks verified") { r.receiver.state.value.verified >= Int64(Wire.blockSize) * 3 }
        XCTAssertEqual(r.peers.all.first?.iceServers.flatMap(\.urls).contains("stun:t:3478"), true, "step all keeps STUN")
        r.peers.blockDirect = true
        try await until("migrated to relay-udp", timeout: 30) { await r.receiver.routeStep == .relayUdp }
        try await until("completed over the relay", timeout: 90) { r.receiver.state.value.phase == .completed }
        let last = try XCTUnwrap(r.peers.all.last { $0.relayOnly })
        XCTAssertEqual(last.iceServers.flatMap(\.urls), ["turn:t:3478?transport=udp"], "relay-udp dials the UDP TURN URI only")
        XCTAssertEqual(r.receiver.state.value.routeKind, .relayUdp)
        XCTAssertEqual(r.receiver.state.value.route, "relay")
        XCTAssertEqual(r.receiver.state.value.duplicates, 0, "verified blocks are not sent again")
        XCTAssertEqual(try sha(XCTUnwrap(r.receiver.state.value.files[0].savedURL)), r.sums[0])
        XCTAssertTrue(r.backend.log.contains { $0.hasSuffix(":DISCONNECTED") }, "the migration was reported")
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    /// Cloud Distribution (docs/TRANSFER_PROTOCOL.md §9): the sender uploads encrypted parts and answers the receiver's
    /// key request; once no peer connection can be made, the receiver finishes from the cloud with route cloud, a
    /// matching SHA-256, and the object is deleted after receipt.
    func testTheReceiverFinishesFromTheCloudWhenPeerToPeerCannotConnect() async throws {
        let r = try await rig(sizes: [3 * 1024 * 1024 + 5], fastClock: true, cloud: true)
        await r.sender.start()
        try await until("uploaded to the cloud", timeout: 30) { r.sender.state.value.cloud?.ready == true }
        await r.receiver.start()
        try await until("the receiver holds the key", timeout: 30) { await r.receiver.cloudReadyCount() == 1 }
        r.peers.refuse = true
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("completed from the cloud", timeout: 60) { r.receiver.state.value.phase == .completed }
        XCTAssertEqual(r.receiver.state.value.route, "cloud")
        XCTAssertEqual(try sha(XCTUnwrap(r.receiver.state.value.files[0].savedURL)), r.sums[0])
        XCTAssertTrue(r.backend.log.contains { $0.hasSuffix(":COMPLETED") }, "\(r.backend.log)")
        XCTAssertEqual(r.backend.cloudObjects.values.first?.status, "DELETED", "deleted after the only receiver had it")
        XCTAssertTrue(r.backend.cloudParts.isEmpty)
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    /// A cloud download that stops part way (a paused budget) goes back to P2P, which loads the cloud's partial file
    /// and sidecar; the sidecar must carry FILE_META's block count (QA round 2: a file over 8 blocks failed here).
    func testACloudDownloadThatStopsFallsBackToPeerToPeerForAFileOverEightBlocks() async throws {
        let size = 9 * Wire.blockSize + 11
        let r = try await rig(sizes: [size], fastClock: true, cloud: true)
        r.backend.cloudRefuseFrom = 3
        await r.sender.start()
        try await until("uploaded to the cloud", timeout: 60) { r.sender.state.value.cloud?.ready == true }
        await r.receiver.start()
        try await until("the receiver holds the key", timeout: 30) { await r.receiver.cloudReadyCount() == 1 }
        r.peers.refuse = true
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("the cloud download stopped at the paused part", timeout: 60) {
            r.backend.cloudPartsServed >= 3
        }
        r.peers.refuse = false
        try await until("completed over P2P", timeout: 120) { r.receiver.state.value.phase == .completed }
        XCTAssertNil(r.receiver.state.value.error)
        XCTAssertEqual(try sha(XCTUnwrap(r.receiver.state.value.files[0].savedURL)), r.sums[0])
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    func testARefusedRelayCredentialShowsTheCapAndStillConnectsDirectly() async throws {
        let r = try await rig(sizes: [5000])
        r.backend.relayCapped = true
        await r.sender.start()
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("completed") { r.receiver.state.value.phase == .completed }
        XCTAssertTrue(r.receiver.state.value.relayCapped)
        XCTAssertEqual(r.peers.all.first?.iceServers, [], "no TURN servers without credentials")
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    func testSenderCancelEndsTheReceiveAndRemovesPartialFiles() async throws {
        let r = try await rig(sizes: [32 * 1024 * 1024], delayMs: 2)
        await r.sender.start()
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("bytes moving") { r.receiver.state.value.verified > 0 }
        await r.sender.cancel(r.receiverPid)
        try await until("receiver cancelled") { r.receiver.state.value.phase == .cancelled }
        try await until("partial removed") {
            ((try? FileManager.default.contentsOfDirectory(atPath: r.inbox.path)) ?? []).isEmpty
        }
        try await until("sender final") { r.sender.state.value.final == .cancelled }
        try await until("receiver history") { await self.entry(r.receiverHistory, "rx:\(r.sessionId)")?.status == .cancelled }
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    func testRemovedReceiverStopsAndTheSenderShowsRemoved() async throws {
        let r = try await rig(sizes: [32 * 1024 * 1024], delayMs: 2)
        await r.sender.start()
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        try await until("bytes moving") { r.receiver.state.value.verified > 0 }
        r.backend.setParticipant(r.sessionId, r.receiverPid, status: "REMOVED")
        try await until("receiver ended") { r.receiver.state.value.phase == .cancelled }
        try await until("sender shows removed") { r.sender.state.value.receivers.first?.status == .removed }
        await r.sender.dispose()
        await r.receiver.dispose()
    }

    func testWithoutTheFilesTheSenderEndsWithFileUnreadable() async throws {
        let r = try await rig(sizes: [1000], keepFiles: false)
        await r.sender.start()
        await r.sender.loaded()
        XCTAssertFalse(r.sender.state.value.hasFiles)
        await r.receiver.start()
        await r.receiver.choose(SaveTarget(kind: .documents, label: "Share Anywhere"))
        do {
            try await until("receiver failed") { r.receiver.state.value.phase == .failed }
        } catch {
            print(
                "DEBUG phase=\(r.receiver.state.value.phase) error=\(String(describing: r.receiver.state.value.error)) log=\(r.backend.log)"
            )
            throw error
        }
        XCTAssertEqual(r.receiver.state.value.error, "product.tx_err_sender_files")
        await r.sender.dispose()
        await r.receiver.dispose()
    }
}
