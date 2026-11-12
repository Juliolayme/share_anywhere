import Foundation
@testable import SAAccount
@testable import SAAPIClient
import XCTest

/// The clipboard engine against an in-memory account clipboard shared by two devices: capture and decrypt on the other
/// device, the offline queue, sensitive skips, delete and clear everywhere, a key rotation mid-send, and pause.
final class ClipboardEngineTests: XCTestCase {
    /// The account's clipboard as backend/internal/clipboard keeps it: ciphertext only, a seq per change, tombstones.
    final class FakeClipboard: @unchecked Sendable {
        let lock = NSLock()
        var events: [ClipboardEvent] = []
        var seq: Int64 = 0
        var currentVersion = 1
        var offline = false
        var settingsValue = ClipboardSettings(paused: false, retentionDays: 7, sensitiveSkip: true)
        var origin: [String: String] = [:]
        var device = ""

        func asDevice(_ d: String) -> Endpoint { Endpoint(server: self, device: d) }

        struct Endpoint: ClipboardEndpoints {
            let server: FakeClipboard
            let device: String
            func history(limit: Int) async throws -> ClipboardHistory { try server.historyNow(limit: limit) }
            func events(cursor: Int64, limit: Int) async throws -> ClipboardEventPage { try server.eventsNow(cursor: cursor, limit: limit) }
            func create(_ req: ClipboardEventRequest) async throws -> ClipboardEventCreated { try server.create(req, device: device) }
            func remove(_ eventID: String) async throws { try server.removeEvent(eventID) }
            func clear() async throws { try server.clearAll() }
            func settings() async throws -> ClipboardSettings { try server.check(); return server.lock
                .withLockedValue { server.settingsValue }
            }

            func saveSettings(_ s: ClipboardSettings) async throws -> ClipboardSettings {
                server.lock.withLockedValue { server.settingsValue = s }
                return s
            }
        }

        func check() throws { if lock.withLockedValue({ offline }) { throw NetworkError(underlying: "offline") } }
        func historyNow(limit _: Int) throws -> ClipboardHistory {
            try check()
            return lock.withLockedValue { ClipboardHistory(events: events.filter { !$0.deleted }, cursor: seq) }
        }

        func eventsNow(cursor: Int64, limit: Int) throws -> ClipboardEventPage {
            try check()
            return lock.withLockedValue {
                let page = Array(events.filter { $0.seq > cursor }.sorted { $0.seq < $1.seq }.prefix(limit))
                return ClipboardEventPage(events: page, nextCursor: page.last?.seq ?? cursor)
            }
        }

        func create(_ r: ClipboardEventRequest, device: String) throws -> ClipboardEventCreated {
            try check()
            return try lock.withLockedValue {
                if r.keyVersion != currentVersion {
                    throw APIError(status: 409, code: "key_version_conflict", message: "", retryAfterSeconds: nil, body: nil)
                }
                if settingsValue.paused { throw APIError(
                    status: 409,
                    code: "clipboard_paused",
                    message: "",
                    retryAfterSeconds: nil,
                    body: nil
                ) }
                if let e = events.first(where: { $0.eventId == r.eventId }) {
                    return ClipboardEventCreated(seq: e.seq, createdAt: e.createdAt, expiresAt: e.expiresAt)
                }
                seq += 1
                let e = ClipboardEvent(
                    eventId: r.eventId, seq: seq, originDeviceId: device, eventType: "TEXT", mimeType: "text/plain",
                    keyVersion: r.keyVersion,
                    nonce: r.nonce, ciphertext: r.ciphertext, payloadSize: r.payloadSize, createdAt: "2026-11-12T06:00:00Z",
                    expiresAt: "2099-01-01T00:00:00Z", deleted: false
                )
                events.append(e)
                return ClipboardEventCreated(seq: e.seq, createdAt: e.createdAt, expiresAt: e.expiresAt)
            }
        }

        func removeEvent(_ id: String) throws {
            try check()
            try lock.withLockedValue {
                guard let i = events.firstIndex(where: { $0.eventId == id && !$0.deleted }) else {
                    throw APIError(status: 404, code: "not_found", message: "", retryAfterSeconds: nil, body: nil)
                }
                seq += 1
                events[i].deleted = true
                events[i].seq = seq
                events[i].nonce = nil
                events[i].ciphertext = nil
            }
        }

        func clearAll() throws {
            try check()
            lock.withLockedValue {
                for i in events.indices where !events[i].deleted {
                    seq += 1
                    events[i].deleted = true
                    events[i].seq = seq
                    events[i].nonce = nil
                    events[i].ciphertext = nil
                }
            }
        }

    }

    var dir: URL!
    let user = UUID().uuidString.lowercased()
    let devA = UUID().uuidString.lowercased()
    let devB = UUID().uuidString.lowercased()

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("sa-cb-\(UUID().uuidString)")
    }

    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    func engine(
        _ server: FakeClipboard,
        _ device: String,
        keys: MemoryKeyStore,
        onConflict: (@Sendable () async -> Void)? = nil
    ) -> ClipboardEngine {
        ClipboardEngine(
            api: server.asDevice(device), keys: .of(keys), store: ClipboardStore(url: dir.appendingPathComponent("\(device).json")),
            userId: user, deviceId: device, onKeyConflict: onConflict, sleep: { _ in try? await Task.sleep(nanoseconds: 5_000_000) }
        )
    }

    func sharedKeys() async throws -> (MemoryKeyStore, MemoryKeyStore) {
        let adk = Primitives.random(32)
        let a = MemoryKeyStore(), b = MemoryKeyStore()
        try await a.save(1, adk)
        try await b.save(1, adk)
        return (a, b)
    }

    func testCaptureSyncsAndTheOtherDeviceDecryptsIt() async throws {
        let server = FakeClipboard()
        let (ka, kb) = try await sharedKeys()
        let a = engine(server, devA, keys: ka), b = engine(server, devB, keys: kb)
        await a.start()
        await b.start()
        let r = await a.capture("Meeting notes for Thursday", source: .manual)
        guard case let .synced(id) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(server.events.count, 1)
        XCTAssertFalse(server.events[0].ciphertext?.contains("Meeting") ?? true, "only ciphertext reaches the server")
        await b.refresh()
        let row = try XCTUnwrap(b.state.value.items.first)
        XCTAssertEqual(row.id, id)
        XCTAssertEqual(row.text, "Meeting notes for Thursday")
        XCTAssertTrue(row.incoming, "new on the other device")
        await b.markCopied(id)
        XCTAssertFalse(b.state.value.items[0].incoming)
        let again = await a.capture("Meeting notes for Thursday", source: .manual)
        XCTAssertEqual(again, .duplicate)
    }

    func testOfflineCapturesQueueAndSendInOrderLater() async throws {
        let server = FakeClipboard()
        let (ka, _) = try await sharedKeys()
        let a = engine(server, devA, keys: ka)
        await a.start()
        server.lock.withLockedValue { server.offline = true }
        let r1 = await a.capture("first", source: .manual)
        let r2 = await a.capture("second", source: .manual)
        guard case .queued(_, .offline) = r1, case .queued = r2 else { return XCTFail("\(r1) \(r2)") }
        XCTAssertEqual(a.state.value.queued, 2)
        XCTAssertTrue(a.state.value.items.allSatisfy(\.pending))
        server.lock.withLockedValue { server.offline = false }
        await a.flush()
        XCTAssertEqual(a.state.value.queued, 0)
        XCTAssertEqual(server.events.map(\.seq), [1, 2])
        // A restart reads the queue from disk (here: nothing left) and the cache.
        let restarted = engine(server, devA, keys: ka)
        await restarted.start()
        XCTAssertEqual(restarted.state.value.items.compactMap(\.text).sorted(), ["first", "second"])
    }

    func testSensitiveTextIsSkippedAutomaticallyAndSyncsOnlyWhenForced() async throws {
        let server = FakeClipboard()
        let (ka, _) = try await sharedKeys()
        let a = engine(server, devA, keys: ka)
        await a.start()
        let auto = await a.capture("482913", source: .auto)
        XCTAssertEqual(auto, .sensitive(.otp))
        XCTAssertEqual(a.state.value.skipped.first?.kind, .otp)
        let flagged = await a.capture("just text", source: .auto, flagged: true)
        XCTAssertEqual(flagged, .sensitive(.flagged))
        let manual = await a.capture("482913", source: .manual)
        XCTAssertEqual(manual, .sensitive(.otp), "manual Sync asks first")
        XCTAssertTrue(server.events.isEmpty, "nothing sensitive was sent")
        let forced = await a.capture("482913", source: .manual, force: true)
        guard case .synced = forced else { return XCTFail("\(forced)") }
    }

    func testRemoveAndClearReachEveryDevice() async throws {
        let server = FakeClipboard()
        let (ka, kb) = try await sharedKeys()
        let a = engine(server, devA, keys: ka), b = engine(server, devB, keys: kb)
        await a.start()
        await b.start()
        guard case let .synced(id1) = await a.capture("one", source: .manual) else { return XCTFail("expected the capture to sync") }
        _ = await a.capture("two", source: .manual)
        await b.refresh()
        XCTAssertEqual(b.state.value.items.count, 2)
        try await b.remove(id1)
        await a.refresh()
        XCTAssertEqual(a.state.value.items.compactMap(\.text), ["two"])
        try await a.clear()
        await b.refresh()
        XCTAssertTrue(b.state.value.items.isEmpty)
    }

    func testAKeyRotationMidSendReencryptsUnderTheNewVersion() async throws {
        let server = FakeClipboard()
        let (ka, _) = try await sharedKeys()
        server.lock.withLockedValue { server.currentVersion = 2 }
        let a = engine(server, devA, keys: ka) {
            try? await ka.save(2, Primitives.random(32))
        }
        await a.start()
        let r = await a.capture("after rotation", source: .manual)
        guard case .synced = r else { return XCTFail("\(r)") }
        XCTAssertEqual(server.events.first?.keyVersion, 2)
    }

    func testPausedSyncCapturesNothing() async throws {
        let server = FakeClipboard()
        server.settingsValue.paused = true
        let (ka, _) = try await sharedKeys()
        let a = engine(server, devA, keys: ka)
        await a.start()
        let r = await a.capture("hello", source: .manual)
        XCTAssertEqual(r, .paused)
        _ = try await a.saveSettings(ClipboardSettings(paused: false, retentionDays: 7, sensitiveSkip: true))
        guard case .synced = await a.capture("hello", source: .manual) else { return XCTFail("expected the capture to sync") }
    }

    func testRowsFromAVersionThisDeviceLacksStayLockedUntilTheKeyArrives() async throws {
        let server = FakeClipboard()
        let (ka, kb) = try await sharedKeys()
        let v2 = Primitives.random(32)
        try await ka.save(2, v2)
        server.lock.withLockedValue { server.currentVersion = 2 }
        let a = engine(server, devA, keys: ka), b = engine(server, devB, keys: kb)
        await a.start()
        await b.start()
        _ = await a.capture("new key", source: .manual)
        await b.refresh()
        XCTAssertNil(b.state.value.items.first?.text)
        XCTAssertEqual(b.state.value.unreadable, 1)
        try await kb.save(2, v2)
        await b.keysChanged()
        XCTAssertEqual(b.state.value.items.first?.text, "new key")
    }
}
