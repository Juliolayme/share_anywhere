import Foundation
@testable import SATransferRuntime
import XCTest

final class RuntimeUnitTests: XCTestCase {
    func testTransitionPaths() {
        XCTAssertEqual(Transitions.path(from: "PENDING", to: "TRANSFERRING"), ["CONNECTING", "TRANSFERRING"])
        XCTAssertEqual(Transitions.path(from: "DISCONNECTED", to: "TRANSFERRING"), ["CONNECTING", "TRANSFERRING"])
        XCTAssertEqual(Transitions.path(from: "DISCONNECTED", to: "RESUMING"), ["RECONNECTING", "RESUMING"])
        XCTAssertEqual(Transitions.path(from: "PAUSED", to: "TRANSFERRING"), [], "leaving PAUSED needs the resume action")
        XCTAssertEqual(Transitions.path(from: "PAUSED", to: "CANCELLED"), ["CANCELLED"])
        XCTAssertEqual(Transitions.path(from: "CONNECTING", to: "COMPLETED"), ["TRANSFERRING", "COMPLETED"])
        XCTAssertEqual(Transitions.path(from: "COMPLETED", to: "FAILED"), [])
        XCTAssertFalse(Transitions.path(from: "PENDING", to: "COMPLETED").contains("PAUSED"))
    }

    func testThroughputIsProvisionalEarlyAndWhenStalled() {
        var t = Throughput()
        t.sample(0, now: 0)
        t.sample(10, now: 1000)
        XCTAssertNil(t.estimate(10, total: 1000).eta, "under 3 %")
        t.sample(500, now: 2000)
        let e = t.estimate(500, total: 1000)
        XCTAssertNotNil(e.eta)
        XCTAssertGreaterThan(e.bytesPerSecond, 0)
        XCTAssertNil(t.estimate(500, total: 1000, reconnecting: true).eta)
        t.sample(500, now: 13000)
        XCTAssertEqual(t.estimate(500, total: 1000).bytesPerSecond, 0, "stalled for 10 s")
    }

    func testSessionResult() {
        func r(_ s: TxStatus, delivered: Bool = false, done: Int = 0) -> ResultInput { ResultInput(
            status: s,
            delivered: delivered,
            done: done,
            total: 2
        ) }
        XCTAssertNil(SessionResult.of([], ended: false))
        XCTAssertNil(SessionResult.of([r(.transferring)], ended: false))
        XCTAssertEqual(SessionResult.of([r(.completed)], ended: false), .completed)
        XCTAssertEqual(SessionResult.of([r(.completed), r(.cancelled, done: 1)], ended: false), .partial)
        XCTAssertEqual(SessionResult.of([r(.failed)], ended: false), .failed)
        XCTAssertNil(SessionResult.of([r(.removed)], ended: false), "only excluded receivers: still open")
        XCTAssertEqual(SessionResult.of([r(.removed), r(.completed)], ended: false), .completed, "removed receivers do not count")
        XCTAssertEqual(SessionResult.of([r(.transferring)], ended: true), .cancelled)
        XCTAssertEqual(SessionResult.statusFromServer(["COMPLETED", "PAUSED"]), .paused)
        XCTAssertEqual(SessionResult.statusFromServer(["COMPLETED", "CANCELLED"]), .cancelled)
        XCTAssertEqual(SessionResult.statusFromServer(["FAILED", "CANCELLED"]), .failed)
        XCTAssertEqual(SessionResult.statusFromServer(["PENDING"]), .waiting)
    }

    func testRedialAndSocketBackoff() {
        XCTAssertEqual(redialDelayMs(0, random: 0.5), 1000)
        XCTAssertEqual(redialDelayMs(10, random: 0.5), 15000)
        XCTAssertEqual(redialDelayMs(1, random: 0), 1500)
        XCTAssertEqual(socketBackoffMs(20, random: 0.5), 30000)
        XCTAssertEqual(socketBackoffMs(2, random: 1), 5000)
    }

    func testIceServersFromTurnCredentials() {
        let c = TurnCredentials(
            username: "u", credential: "c", uris: ["turn:turn.example:3478?transport=udp", "turn:turn.example:3478?transport=tcp"],
            ttl: 1800, expiresAt: ""
        )
        let s = ICEServer.from(c)
        XCTAssertEqual(s.count, 2)
        XCTAssertEqual(s[0].urls, ["stun:turn.example:3478"])
        XCTAssertEqual(s[1].username, "u")
        XCTAssertEqual(ICEServer.from(nil), [])
    }

    func testCandidateSanitizing() {
        XCTAssertNil(CandidateJSON(candidate: "").sanitized())
        XCTAssertNil(CandidateJSON(candidate: String(repeating: "a", count: 1025)).sanitized())
        let c = CandidateJSON(candidate: "candidate:1", sdpMid: String(repeating: "m", count: 65), sdpMLineIndex: 0, usernameFragment: "u")
        XCTAssertNil(c.sanitized()?.sdpMid)
        XCTAssertEqual(c.sanitized()?.usernameFragment, "u")
    }

    func testSignalMessageCarriesThePayloadAsJSON() throws {
        let m = try XCTUnwrap(signalMessage(
            type: "OFFER", sessionId: "s", to: "p", payload: SDPPayload(conn: "c", sdp: SDPJSON(type: "offer", sdp: "v=0"))
        ))
        let e = SocketEvent(type: "OFFER", body: m)
        XCTAssertEqual(e.decode("payload", as: SDPPayload.self), SDPPayload(conn: "c", sdp: SDPJSON(type: "offer", sdp: "v=0")))
        let c = try XCTUnwrap(signalMessage(
            type: "ICE_CANDIDATE", sessionId: "s", to: "p",
            payload: CandidatePayload(conn: "c", candidate: CandidateJSON(candidate: "x", sdpMid: "0", sdpMLineIndex: 0))
        ))
        XCTAssertEqual(
            SocketEvent(type: "ICE_CANDIDATE", body: c).decode("payload", as: CandidatePayload.self)?.candidate?.sdpMLineIndex,
            0
        )
    }

    func testSafeFileNames() {
        XCTAssertEqual(IncomingFolder.safeName("../../etc/passwd"), "_.._etc_passwd")
        XCTAssertEqual(IncomingFolder.safeName(".hidden"), "hidden")
        XCTAssertEqual(IncomingFolder.safeName(""), "file")
        XCTAssertEqual(IncomingFolder.safeName("a:b\u{0}c.txt"), "a_b_c.txt")
        XCTAssertLessThanOrEqual(IncomingFolder.safeName(String(repeating: "x", count: 300) + ".pdf").count, 200)
        XCTAssertTrue(IncomingFolder.safeName(String(repeating: "x", count: 300) + ".pdf").hasSuffix(".pdf"))
        // A sender-chosen name with an extension longer than the limit (the server allows 255 characters).
        let longExt = IncomingFolder.safeName("a." + String(repeating: "x", count: 253))
        XCTAssertLessThanOrEqual(longExt.count, 200)
        XCTAssertTrue(longExt.hasPrefix("a."))
        XCTAssertLessThanOrEqual(
            IncomingFolder.safeName(String(repeating: "y", count: 180) + "." + String(repeating: "z", count: 40)).count,
            200
        )
    }

    func testIncomingFolderSidecarLifecycle() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sa-in-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let folder = IncomingFolder(directory: dir)
        var s = try folder.create("k1", name: "a.txt", size: 10, blockSize: 4, blockCount: 3, now: 1)
        XCTAssertEqual(folder.load("k1", size: 10, blockSize: 4), s)
        XCTAssertNil(folder.load("k1", size: 11, blockSize: 4), "another file size: no resume")
        var bm = try Bitmap(size: 3, bytes: [UInt8](s.bitmap))
        bm.set(1)
        s.bitmap = Data(bm.bytes)
        try folder.save(s)
        XCTAssertEqual(folder.load("k1", size: 10, blockSize: 4)?.bitmap, Data([2]))
        try Data("x".utf8).write(to: dir.appendingPathComponent("a.txt"))
        let final = try folder.finish("k1", name: "a.txt")
        XCTAssertEqual(final.lastPathComponent, "a (1).txt", "existing names are kept")
        XCTAssertNil(folder.peek("k1"))
        _ = try folder.create("k2", name: "b", size: 1, blockSize: 4, blockCount: 1, now: 1)
        folder.discard("k2")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted(), ["a (1).txt", "a.txt"])
    }

    func testJSONMapPersists() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sa-map-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let a = JSONMap<SaveTarget>(url: url)
        try await a.put("s1", SaveTarget(kind: .documents, label: "Share Anywhere"))
        let b = JSONMap<SaveTarget>(url: url)
        let got = await b.get("s1")
        XCTAssertEqual(got?.kind, .documents)
        try await b.put("s1", nil)
        let none = await JSONMap<SaveTarget>(url: url).get("s1")
        XCTAssertNil(none)
    }

    func testStateCellStreamsTheCurrentValueThenChanges() async {
        let cell = StateCell(1)
        var it = cell.values().makeAsyncIterator()
        let first = await it.next()
        XCTAssertEqual(first, 1)
        cell.set(2)
        let second = await it.next()
        XCTAssertEqual(second, 2)
    }
}

/// Reports walk the state machine and progress is throttled.
final class ReporterTests: XCTestCase {
    final class Sink: ReportSink, @unchecked Sendable {
        let lock = NSLock()
        var sent: [String] = []
        func report(transferId _: String, status: String, verifiedBytes _: Int64, route _: String?) async throws -> String {
            lock.locked { sent.append(status) }
            return status
        }

        var all: [String] { lock.locked { sent } }
    }

    func testStateWalksThroughIntermediateStates() async {
        let sink = Sink()
        let r = Reporter(sink: sink)
        await r.state("t", "TRANSFERRING", bytes: 0)
        await r.state("t", "DISCONNECTED")
        await r.state("t", "TRANSFERRING")
        XCTAssertEqual(sink.all, ["CONNECTING", "TRANSFERRING", "DISCONNECTED", "CONNECTING", "TRANSFERRING"])
    }

    func testLeavingPausedUsesTheResumeActionOrStays() async {
        let sink = Sink()
        let r = Reporter(sink: sink)
        await r.seed("t", "PAUSED", 0)
        await r.setResume { _ in nil }
        await r.state("t", "TRANSFERRING")
        XCTAssertEqual(sink.all, [], "stays paused")
        await r.setResume { _ in "RESUMING" }
        await r.state("t", "TRANSFERRING")
        XCTAssertEqual(sink.all, ["TRANSFERRING"])
    }

    func testProgressIsThrottled() async throws {
        let sink = Sink()
        let r = Reporter(sink: sink, intervalMs: 50)
        await r.seed("t", "TRANSFERRING", 0)
        for i in 0 ..< 20 {
            await r.progress("t", Int64(i))
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(sink.all.count, 1)
    }
}

/// The socket reconnects after a drop and announces SOCKET_OPEN / SOCKET_CLOSED around WELCOME.
final class SessionSocketTests: XCTestCase {
    func testOpenEventsAndRelayAndReconnect() async throws {
        let backend = FakeBackend()
        let client = backend.client("d1")
        let socket = SessionSocket(baseURL: URL(string: "https://api.example")!, connector: client, ticket: { "t" }, pause: { _ in })
        var it = socket.events().makeAsyncIterator()
        let open = await it.next()
        XCTAssertEqual(open?.type, SocketEvent.open)
        let welcome = await it.next()
        XCTAssertEqual(welcome?.type, "WELCOME")
        XCTAssertTrue(socket.isConnected)
        backend.push(to: "d1", ["type": .string("SESSION_UPDATED"), "session_id": .string("s")])
        let upd = await it.next()
        XCTAssertEqual(upd?.sessionId, "s")
        // Drop every connection: CLOSED, then a new OPEN after the reconnect.
        for q in backend.queues("d1") {
            backend.disconnect(device: "d1", q)
        }
        let closed = await it.next()
        XCTAssertEqual(closed?.type, SocketEvent.closed)
        let reopened = await it.next()
        XCTAssertEqual(reopened?.type, SocketEvent.open)
    }

    func testSendFailsWhileDisconnected() {
        let socket = SessionSocket(baseURL: URL(string: "https://api.example")!, connector: FakeBackend().client("d"), ticket: { "t" })
        XCTAssertFalse(socket.send(["type": .string("OFFER")]))
    }
}

extension FakeBackend {
    func queues(_ device: String) -> [AsyncQueue<String>] {
        // Test-only access to the open sockets of a device.
        Mirror(reflecting: self).children.first { $0.label == "sockets" }
            .flatMap { ($0.value as? [String: [AsyncQueue<String>]])?[device] } ?? []
    }
}
