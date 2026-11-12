import Foundation

public enum Direction: String, Codable, Sendable { case sent, received }

public enum HistoryStatus: String, Codable, Sendable { case completed, partial, failed, cancelled }

/// How the bytes travelled: one route for every receiver, or a mix.
public enum HistoryRoute: String, Codable, Sendable { case direct, relay, mixed }

/// One file of an entry.
public struct HistoryFile: Codable, Sendable, Equatable {
    public var name: String
    public var size: Int64
    /// Bytes that arrived or were verified when the transfer ended short of `size`.
    public var transferredBytes: Int64?

    public init(name: String, size: Int64, transferredBytes: Int64? = nil) {
        self.name = name
        self.size = size
        self.transferredBytes = transferredBytes
    }
}

/// One local History entry (PRD §2 History, docs/UX_SCREEN_MAP.md HI-1). Fields mirror the Web and Android entries so
/// cloud history sync carries the same JSON between clients. Guest history never leaves the device.
public struct HistoryEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var direction: Direction
    /// Main file name, or a summary such as "3 files".
    public var title: String
    public var fileCount: Int
    public var totalBytes: Int64
    /// Bytes that arrived (or were verified) when the transfer ended short of `totalBytes`.
    public var transferredBytes: Int64?
    /// The other side's display name (receiver or sender).
    public var peer: String
    public var status: HistoryStatus
    /// Epoch milliseconds when the transfer ended.
    public var createdAt: Int64
    /// Each peer's display name when there were several receivers; `peer` stays the joined summary.
    public var peers: [String]?
    /// Per-file names and sizes, for search by file name and the detail view.
    public var files: [HistoryFile]?
    public var route: HistoryRoute?
    /// Epoch milliseconds when the first byte moved.
    public var startedAt: Int64?
    /// Name of the account device this entry came from (cloud history sync).
    public var origin: String?

    public init(
        id: String, direction: Direction, title: String, fileCount: Int, totalBytes: Int64, transferredBytes: Int64? = nil,
        peer: String, status: HistoryStatus, createdAt: Int64, peers: [String]? = nil, files: [HistoryFile]? = nil,
        route: HistoryRoute? = nil, startedAt: Int64? = nil, origin: String? = nil
    ) {
        self.id = id
        self.direction = direction
        self.title = title
        self.fileCount = fileCount
        self.totalBytes = totalBytes
        self.transferredBytes = transferredBytes
        self.peer = peer
        self.status = status
        self.createdAt = createdAt
        self.peers = peers
        self.files = files
        self.route = route
        self.startedAt = startedAt
        self.origin = origin
    }

    /// The peers of an entry: the per-receiver list when recorded, else the single peer name.
    public var peerNames: [String] {
        let list = (peers ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if !list.isEmpty { return list }
        return peer.trimmingCharacters(in: .whitespaces).isEmpty ? [] : [peer]
    }

    /// Bytes that moved: the recorded count, else the full size for a completed entry, else unknown.
    public var transferred: Int64? { transferredBytes ?? (status == .completed ? totalBytes : nil) }
}

/// How long local History keeps entries (Settings › Privacy & retention). Stored values match the Web's and Android's.
public enum Retention: String, Sendable, CaseIterable {
    case days30 = "30", days90 = "90", none

    public static let `default` = Retention.days30
    public var days: Int {
        switch self {
        case .days30: 30
        case .days90: 90
        case .none: 0
        }
    }

    public static func fromStored(_ v: String?) -> Retention { v.flatMap(Retention.init(rawValue:)) ?? .default }
}

/// The History screen's chips: All, Sent, Received, Failed.
public enum HistoryChip: Sendable, CaseIterable { case all, sent, received, failed }

/// Date presets, "All" first so a 90-day retention never hides entries by default.
public enum HistoryRange: Sendable, CaseIterable { case all, days30, days7, today }

/// Search and filters for HI-1: chip, file or device name, status, date range, peer device.
public struct HistoryFilter: Sendable, Equatable {
    public var chip: HistoryChip = .all
    public var query = ""
    public var status: HistoryStatus?
    public var range: HistoryRange = .all
    public var peer: String?
    public init() {}
    public var isDefault: Bool { self == HistoryFilter() }
}

public enum HistoryQuery {
    public static let dayMs: Int64 = 24 * 60 * 60 * 1000

    /// Every peer in the entries, sorted, for the device filter.
    public static func peers(_ entries: [HistoryEntry]) -> [String] { Array(Set(entries.flatMap(\.peerNames))).sorted() }

    /// Start of a date window in epoch ms (0 = no lower bound); "today" uses the given calendar's time zone.
    public static func rangeStart(_ range: HistoryRange, now: Int64, calendar: Calendar = .current) -> Int64 {
        switch range {
        case .all: return 0
        case .days30: return now - 30 * dayMs
        case .days7: return now - 7 * dayMs
        case .today:
            let start = calendar.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(now) / 1000))
            return Int64(start.timeIntervalSince1970 * 1000)
        }
    }

    /// Same matching as the Web's `filterHistory` and Android's, with the design's Failed chip.
    public static func filter(_ entries: [HistoryEntry], _ f: HistoryFilter, now: Int64, calendar: Calendar = .current) -> [HistoryEntry] {
        let q = f.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let since = rangeStart(f.range, now: now, calendar: calendar)
        return entries.filter { e in
            let chipOK = switch f.chip {
            case .all: true
            case .sent: e.direction == .sent
            case .received: e.direction == .received
            case .failed: e.status == .failed
            }
            let searchable = [e.title, e.peer] + e.peerNames + (e.files ?? []).map(\.name)
            return chipOK && (f.status == nil || e.status == f.status) && (f.peer == nil || e.peerNames.contains(f.peer!)) &&
                e.createdAt >= since && (q.isEmpty || searchable.contains { $0.lowercased().contains(q) })
        }
    }
}

/// Told about deletions made by the user, so synced copies are tombstoned too (cloud history sync, signed in only).
public protocol HistorySyncHandler: Sendable {
    func removed(_ ids: [String]) async
    func cleared() async
}

/// Local History store for guests and signed-in users alike (PRD §2 History), the twin of Android's
/// `HistoryRepository`: SQLite here instead of Room, the same rules (removed ids remembered for 7 days, retention).
public actor HistoryStore {
    /// Longer than any session lives (72 h signed in), as on the Web and Android.
    public static let removedTTL: Int64 = 7 * HistoryQuery.dayMs
    public static let removedMax = 500

    private let db: Database
    private let clock: @Sendable () -> Int64
    private var observers: [UUID: AsyncStream<[HistoryEntry]>.Continuation] = [:]
    public var syncHandler: (any HistorySyncHandler)?

    public init(path: String, clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) throws {
        db = try Database(path: path)
        self.clock = clock
        try HistoryStore.migrate(db)
    }

    static func migrate(_ db: Database) throws {
        if db.userVersion < 1 {
            try db.transaction {
                try db.execute("""
                CREATE TABLE IF NOT EXISTS history (
                    id TEXT PRIMARY KEY NOT NULL, direction TEXT NOT NULL, title TEXT NOT NULL, file_count INTEGER NOT NULL,
                    total_bytes INTEGER NOT NULL, transferred_bytes INTEGER, peer TEXT NOT NULL, status TEXT NOT NULL,
                    created_at INTEGER NOT NULL, peers TEXT, files TEXT, route TEXT, started_at INTEGER, origin TEXT)
                """)
                try db.execute("CREATE INDEX IF NOT EXISTS history_created_at ON history(created_at)")
                try db.execute("CREATE TABLE IF NOT EXISTS history_removed (id TEXT PRIMARY KEY NOT NULL, removed_at INTEGER NOT NULL)")
                try db.execute("CREATE INDEX IF NOT EXISTS history_removed_at ON history_removed(removed_at)")
            }
            db.userVersion = 1
        }
    }

    public func setSyncHandler(_ handler: (any HistorySyncHandler)?) { syncHandler = handler }

    /// Every entry, newest first.
    public func list() throws -> [HistoryEntry] {
        try db.query("SELECT * FROM history ORDER BY created_at DESC, id").compactMap(HistoryStore.entry)
    }

    public func get(_ id: String) throws -> HistoryEntry? {
        try db.query("SELECT * FROM history WHERE id = ?", [.text(id)]).first.flatMap(HistoryStore.entry)
    }

    /// The current list, then the new list after every change.
    public func observe() -> AsyncStream<[HistoryEntry]> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<[HistoryEntry]>.makeStreamCompat()
        observers[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.dropObserver(id) } }
        continuation.yield((try? list()) ?? [])
        return stream
    }

    private func dropObserver(_ id: UUID) { observers[id] = nil }

    private func changed() {
        let all = (try? list()) ?? []
        for c in observers.values {
            c.yield(all)
        }
    }

    /// Writes `entry` (replacing the same id) unless the user deleted that id in the last 7 days.
    @discardableResult
    public func add(_ entry: HistoryEntry) throws -> Bool {
        let since = clock() - HistoryStore.removedTTL
        let written = try db.transaction { () throws -> Bool in
            let removed = try db.query("SELECT 1 AS x FROM history_removed WHERE id = ? AND removed_at > ?", [.text(entry.id), .int(since)])
            if !removed.isEmpty { return false }
            try db.execute(
                """
                INSERT OR REPLACE INTO history (id, direction, title, file_count, total_bytes, transferred_bytes, peer, status, created_at,
                    peers, files, route, started_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                HistoryStore.row(entry)
            )
            return true
        }
        if written { changed() }
        return written
    }

    /// The user deleted an entry: removed here, and its synced copy tombstoned when history sync is on.
    public func remove(_ id: String) async throws {
        try removeLocal(id)
        await syncHandler?.removed([id])
    }

    /// Removes an entry on this device only (a tombstone pulled from the account).
    public func removeLocal(_ id: String) throws {
        let now = clock()
        try db.transaction {
            try db.execute("DELETE FROM history WHERE id = ?", [.text(id)])
            try remember([id], now: now)
        }
        changed()
    }

    /// Clear all; `sync` also tombstones the synced copies when history sync is on (not on sign-out).
    public func clear(sync: Bool = true) async throws {
        let now = clock()
        try db.transaction {
            let ids = try db.query("SELECT id FROM history").compactMap { $0.string("id") }
            try db.execute("DELETE FROM history")
            try remember(ids, now: now)
        }
        changed()
        if sync { await syncHandler?.cleared() }
    }

    /// Deletes entries older than the retention period ("none" deletes all). Returns the count removed.
    @discardableResult
    public func sweep(_ retention: Retention, now: Int64? = nil) throws -> Int {
        let cutoff = retention.days == 0 ? Int64.max : (now ?? clock()) - Int64(retention.days) * HistoryQuery.dayMs
        try db.execute("DELETE FROM history WHERE created_at <= ?", [.int(cutoff)])
        let n = db.changes
        if n > 0 { changed() }
        return n
    }

    private func remember(_ ids: [String], now: Int64) throws {
        for id in ids {
            try db.execute("INSERT OR REPLACE INTO history_removed (id, removed_at) VALUES (?, ?)", [.text(id), .int(now)])
        }
        try db.execute("DELETE FROM history_removed WHERE removed_at <= ?", [.int(now - HistoryStore.removedTTL)])
        try db.execute(
            "DELETE FROM history_removed WHERE id NOT IN (SELECT id FROM history_removed ORDER BY removed_at DESC LIMIT ?)",
            [.int(Int64(HistoryStore.removedMax))]
        )
    }

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    private static func json(_ v: (some Encodable)?) -> SQLValue {
        guard let v, let d = try? encoder.encode(v), let s = String(data: d, encoding: .utf8) else { return .null }
        return .text(s)
    }

    private static func row(_ e: HistoryEntry) -> [SQLValue] {
        [
            .text(e.id), .text(e.direction.rawValue), .text(e.title), .int(Int64(e.fileCount)), .int(e.totalBytes),
            e.transferredBytes.map(SQLValue.int) ?? .null, .text(e.peer), .text(e.status.rawValue), .int(e.createdAt),
            json(e.peers), json(e.files), e.route.map { .text($0.rawValue) } ?? .null, e.startedAt.map(SQLValue.int) ?? .null,
            e.origin.map(SQLValue.text) ?? .null
        ]
    }

    private static func entry(_ r: [String: SQLValue]) -> HistoryEntry? {
        guard let id = r.string("id"), let dir = r.string("direction").flatMap(Direction.init(rawValue:)), let title = r.string("title"),
              let count = r.int("file_count"), let total = r.int("total_bytes"), let peer = r.string("peer"),
              let status = r.string("status").flatMap(HistoryStatus.init(rawValue:)), let created = r.int("created_at") else { return nil }
        return HistoryEntry(
            id: id, direction: dir, title: title, fileCount: Int(count), totalBytes: total, transferredBytes: r.int("transferred_bytes"),
            peer: peer, status: status, createdAt: created,
            peers: r.string("peers").flatMap { try? decoder.decode([String].self, from: Data($0.utf8)) },
            files: r.string("files").flatMap { try? decoder.decode([HistoryFile].self, from: Data($0.utf8)) },
            route: r.string("route").flatMap(HistoryRoute.init(rawValue:)), startedAt: r.int("started_at"), origin: r.string("origin")
        )
    }
}

extension AsyncStream {
    static func makeStreamCompat() -> (AsyncStream<Element>, AsyncStream<Element>.Continuation) {
        var continuation: AsyncStream<Element>.Continuation!
        let stream = AsyncStream<Element> { continuation = $0 }
        return (stream, continuation)
    }
}
