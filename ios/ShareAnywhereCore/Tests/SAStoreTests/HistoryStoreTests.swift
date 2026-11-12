import Foundation
@testable import SAStore
import XCTest

final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var now: Int64 = 1_800_000_000_000
    func get() -> Int64 { lock.withLock { now } }
    func advance(_ ms: Int64) { lock.withLock { now += ms } }
}

actor SyncSpy: HistorySyncHandler {
    var removedIDs: [String] = []
    var clears = 0
    func removed(_ ids: [String]) async { removedIDs += ids }
    func cleared() async { clears += 1 }
}

/// Local History on iOS (PRD §2 History, docs/UX_SCREEN_MAP.md HI-1), the cases of Android's repository tests.
final class HistoryStoreTests: XCTestCase {
    func entry(
        _ id: String,
        _ dir: Direction = .received,
        status: HistoryStatus = .completed,
        at: Int64,
        peer: String = "Office PC"
    ) -> HistoryEntry {
        HistoryEntry(
            id: id, direction: dir, title: "\(id).zip", fileCount: 1, totalBytes: 1000, peer: peer, status: status, createdAt: at,
            files: [HistoryFile(name: "\(id).zip", size: 1000)]
        )
    }

    func tempPath() -> String { FileManager.default.temporaryDirectory.appendingPathComponent("history-\(UUID().uuidString).sqlite").path }

    func testEntriesPersistAcrossReopenNewestFirst() async throws {
        let path = tempPath()
        let clock = Clock()
        do {
            let s = try HistoryStore(path: path, clock: { clock.get() })
            try await s.add(entry("a", at: 1000))
            var b = entry("b", .sent, at: 2000)
            b.peers = ["Phone", "Laptop"]
            b.route = .direct
            try await s.add(b)
        }
        let reopened = try HistoryStore(path: path, clock: { clock.get() })
        let all = try await reopened.list()
        XCTAssertEqual(all.map(\.id), ["b", "a"])
        XCTAssertEqual(all.first?.peers, ["Phone", "Laptop"])
        XCTAssertEqual(all.first?.route, .direct)
        XCTAssertEqual(all.last?.files, [HistoryFile(name: "a.zip", size: 1000)])
    }

    func testADeletedEntryIsNotBroughtBackBySameIdWithinSevenDays() async throws {
        let clock = Clock()
        let s = try HistoryStore(path: tempPath(), clock: { clock.get() })
        let spy = SyncSpy()
        await s.setSyncHandler(spy)
        try await s.add(entry("a", at: 1000))
        try await s.remove("a")
        let rewritten = try await s.add(entry("a", at: 2000))
        XCTAssertFalse(rewritten)
        let removed = await spy.removedIDs
        XCTAssertEqual(removed, ["a"])
        clock.advance(HistoryStore.removedTTL + 1)
        let later = try await s.add(entry("a", at: 3000))
        XCTAssertTrue(later)
    }

    func testClearRemembersEveryIdAndTombstonesOnlyWhenAsked() async throws {
        let s = try HistoryStore(path: tempPath())
        let spy = SyncSpy()
        await s.setSyncHandler(spy)
        try await s.add(entry("a", at: 1))
        try await s.add(entry("b", at: 2))
        try await s.clear(sync: false)
        let clears = await spy.clears
        XCTAssertEqual(clears, 0)
        let none = try await s.list()
        XCTAssertTrue(none.isEmpty)
        let back = try await s.add(entry("b", at: 3))
        XCTAssertFalse(back)
        try await s.clear()
        let after = await spy.clears
        XCTAssertEqual(after, 1)
    }

    func testRetentionSweepsOldEntries() async throws {
        let clock = Clock()
        let s = try HistoryStore(path: tempPath(), clock: { clock.get() })
        let now = clock.get()
        try await s.add(entry("old", at: now - 31 * HistoryQuery.dayMs))
        try await s.add(entry("new", at: now - HistoryQuery.dayMs))
        let n = try await s.sweep(.days30)
        XCTAssertEqual(n, 1)
        let left = try await s.list().map(\.id)
        XCTAssertEqual(left, ["new"])
        try await s.sweep(.none)
        let none = try await s.list()
        XCTAssertTrue(none.isEmpty)
        XCTAssertEqual(Retention.fromStored("90"), .days90)
        XCTAssertEqual(Retention.fromStored("x"), .days30)
    }

    func testObserversSeeEveryChange() async throws {
        let s = try HistoryStore(path: tempPath())
        var it = await s.observe().makeAsyncIterator()
        let first = await it.next()
        XCTAssertEqual(first?.count, 0)
        try await s.add(entry("a", at: 1))
        let second = await it.next()
        XCTAssertEqual(second?.map(\.id), ["a"])
    }

    func testFiltersMatchTheWebAndAndroid() {
        let now: Int64 = 1_800_000_000_000
        var multi = entry("m", .sent, at: now - 2 * HistoryQuery.dayMs, peer: "2 devices")
        multi.peers = ["Phone", "Laptop"]
        let entries = [
            entry("r", at: now - 10 * HistoryQuery.dayMs),
            entry("f", status: .failed, at: now - HistoryQuery.dayMs, peer: "Kitchen iPad"),
            multi
        ]
        var f = HistoryFilter()
        XCTAssertTrue(f.isDefault)
        f.chip = .sent
        XCTAssertEqual(HistoryQuery.filter(entries, f, now: now).map(\.id), ["m"])
        f = HistoryFilter()
        f.chip = .failed
        XCTAssertEqual(HistoryQuery.filter(entries, f, now: now).map(\.id), ["f"])
        f = HistoryFilter()
        f.query = "  LAPTOP "
        XCTAssertEqual(HistoryQuery.filter(entries, f, now: now).map(\.id), ["m"])
        f = HistoryFilter()
        f.query = "r.zip"
        XCTAssertEqual(HistoryQuery.filter(entries, f, now: now).map(\.id), ["r"])
        f = HistoryFilter()
        f.range = .days7
        XCTAssertEqual(Set(HistoryQuery.filter(entries, f, now: now).map(\.id)), ["f", "m"])
        f = HistoryFilter()
        f.peer = "Phone"
        XCTAssertEqual(HistoryQuery.filter(entries, f, now: now).map(\.id), ["m"])
        XCTAssertEqual(HistoryQuery.peers(entries), ["Kitchen iPad", "Laptop", "Office PC", "Phone"])
        XCTAssertEqual(entries[1].transferred, nil)
        XCTAssertEqual(entries[0].transferred, 1000)
    }
}
