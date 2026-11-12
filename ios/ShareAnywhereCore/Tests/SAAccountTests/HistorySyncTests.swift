import Foundation
@testable import SAAccount
@testable import SAAPIClient
import SAStore
import XCTest

/// History sync payloads and passes (the Web's historySync.test.ts and Android's HistorySyncTest rules): the uploaded
/// JSON round-trips, unknown or malformed fields never reach History, entry ids are stable per device, and a pass
/// pushes new local entries, pulls the other device's, applies tombstones, and retries unreadable entries after a key
/// arrives.
final class HistorySyncTests: XCTestCase {
    final class FakeHistory: HistoryEndpoints, @unchecked Sendable {
        let lock = NSLock()
        var rows: [SAAPIClient.HistoryEntry] = []
        var seq: Int64 = 0
        var device = ""
        func historyEntries(after: Int64, limit: Int) async throws -> HistoryPage {
            lock.withLockedValue {
                let page = Array(rows.filter { $0.seq > after }.sorted { $0.seq < $1.seq }.prefix(limit))
                return HistoryPage(entries: page, nextAfter: page.last?.seq ?? after)
            }
        }

        func addHistoryEntry(_ r: HistoryEntryRequest) async throws -> Int64 {
            lock.withLockedValue {
                seq += 1
                rows.removeAll { $0.entryId == r.entryId }
                rows.append(SAAPIClient.HistoryEntry(
                    entryId: r.entryId, seq: seq, keyVersion: r.keyVersion, nonce: r.nonce, ciphertext: r.ciphertext,
                    originDeviceId: device,
                    createdAt: "2026-11-12T06:00:00Z", deleted: false
                ))
                return seq
            }
        }

        func deleteHistoryEntry(_ id: String) async throws {
            try lock.withLockedValue {
                guard let i = rows.firstIndex(where: { $0.entryId == id }) else {
                    throw APIError(status: 404, code: "not_found", message: "", retryAfterSeconds: nil, body: nil)
                }
                seq += 1
                rows[i].deleted = true
                rows[i].seq = seq
                rows[i].nonce = nil
                rows[i].ciphertext = nil
            }
        }

        func clearHistory() async throws {
            lock.withLockedValue {
                for i in rows.indices where !rows[i].deleted {
                    seq += 1
                    rows[i].deleted = true
                    rows[i].seq = seq
                }
            }
        }
    }

    func sample(_ id: String, at: Int64 = 1_731_400_000_000) -> SAStore.HistoryEntry {
        SAStore.HistoryEntry(
            id: id, direction: .received, title: "holiday.zip", fileCount: 2, totalBytes: 2_400_000_000, transferredBytes: 1_000_000,
            peer: "Office PC",
            status: .partial, createdAt: at, peers: ["Office PC"],
            files: [HistoryFile(name: "a.jpg", size: 10, transferredBytes: 5), HistoryFile(name: "b.jpg", size: 20)],
            route: .relay, startedAt: at - 1000
        )
    }

    func testPayloadRoundTripsAndValidates() throws {
        let e = sample("rx:1")
        let parsed = try XCTUnwrap(HistorySync.parseEntry(HistorySync.payload(e), id: "sync:x"))
        var expected = e
        expected.id = "sync:x"
        XCTAssertEqual(parsed, expected)
        XCTAssertNil(HistorySync.parseEntry(
            #"{"direction":"sideways","title":"a","peer":"b","status":"completed","fileCount":1,"totalBytes":1,"createdAt":1}"#,
            id: "x"
        ))
        XCTAssertNil(HistorySync.parseEntry(
            #"{"direction":"sent","title":"a","peer":"b","status":"completed","fileCount":-1,"totalBytes":1,"createdAt":1}"#,
            id: "x"
        ))
        let extra = HistorySync.parseEntry(
            #"{"direction":"sent","title":"a","peer":"b","status":"completed","fileCount":1,"totalBytes":1,"createdAt":1,"evil":"x","peers":[1]}"#,
            id: "x"
        )
        XCTAssertNotNil(extra)
        XCTAssertNil(extra?.peers, "malformed peers are dropped")
        XCTAssertFalse(HistorySync.payload(e).contains("origin"), "local-only fields are not uploaded")
    }

    func testEntryIDsAreStableVersion8UUIDs() {
        let a = HistorySync.entryUUID(localID: "rx:1", deviceID: "d1")
        XCTAssertEqual(a, HistorySync.entryUUID(localID: "rx:1", deviceID: "d1"))
        XCTAssertNotEqual(a, HistorySync.entryUUID(localID: "rx:1", deviceID: "d2"))
        XCTAssertTrue(Items.isItemID(a))
        XCTAssertEqual(Array(a)[14], "8")
    }

    func testAPassPushesPullsAndAppliesTombstones() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sa-hs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let adk = Primitives.random(32)
        let ka = MemoryKeyStore(), kb = MemoryKeyStore()
        try await ka.save(1, adk)
        let server = FakeHistory()
        let ha = try HistoryStore(path: dir.appendingPathComponent("a.sqlite").path)
        let hb = try HistoryStore(path: dir.appendingPathComponent("b.sqlite").path)
        let ma = HistoryMetaStore(url: dir.appendingPathComponent("ma.json"), clock: { 0 })
        let mb = HistoryMetaStore(url: dir.appendingPathComponent("mb.json"), clock: { 0 })
        _ = try await ha.add(sample("rx:1"))
        server.device = "dev-a"
        let ra = try await HistorySync.sync(.init(
            api: server,
            keys: ka,
            history: ha,
            meta: ma,
            userId: "u",
            deviceId: "dev-a",
            enabled: true
        ))
        XCTAssertEqual(ra.pushed, 1)

        // B lacks the key: the entry is unreadable and retried once the key arrives.
        server.device = "dev-b"
        let rb = try await HistorySync.sync(.init(
            api: server,
            keys: kb,
            history: hb,
            meta: mb,
            userId: "u",
            deviceId: "dev-b",
            enabled: true,
            deviceNames: ["dev-a": "iPhone A"]
        ))
        XCTAssertEqual(rb.unreadable, 1)
        try await kb.save(1, adk)
        let rb2 = try await HistorySync.sync(.init(
            api: server,
            keys: kb,
            history: hb,
            meta: mb,
            userId: "u",
            deviceId: "dev-b",
            enabled: true,
            deviceNames: ["dev-a": "iPhone A"]
        ))
        XCTAssertEqual(rb2.pulled, 1)
        let onB = try await hb.list()
        XCTAssertEqual(onB.first?.title, "holiday.zip")
        XCTAssertEqual(onB.first?.origin, "iPhone A")

        // A deletes its entry: B removes the synced copy on the next pass.
        try await HistorySync.deleteSynced(server, ma, userId: "u", localIDs: ["rx:1"])
        _ = try await HistorySync.sync(.init(api: server, keys: kb, history: hb, meta: mb, userId: "u", deviceId: "dev-b", enabled: true))
        let after = try await hb.list()
        XCTAssertTrue(after.isEmpty)
    }
}
