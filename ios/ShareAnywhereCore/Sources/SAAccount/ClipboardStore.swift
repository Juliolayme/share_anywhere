import Foundation

/// A capture waiting to be sent (already encrypted; the plaintext never touches disk).
public struct QueuedEvent: Codable, Sendable, Equatable {
    public var userId: String
    public var eventId: String
    public var keyVersion: Int
    public var nonce: String
    public var ciphertext: String
    public var payloadSize: Int
    public var queuedAt: Int64
}

/// A delete waiting for the network, or for the grace period after a 404 (§2.9).
public struct PendingDelete: Codable, Sendable, Equatable {
    public var userId: String
    public var eventId: String
    public var at: Int64
    public var due: Int64
}

public struct ClipboardSyncState: Codable, Sendable, Equatable {
    public var cursor: Int64
    public var syncedAt: Int64
}

public struct ClipboardStoreSnapshot: Sendable {
    public var events: [ClipboardEvent]
    public var queue: [QueuedEvent]
    public var deletes: [PendingDelete]
    public var sync: ClipboardSyncState?
}

/// The encrypted clipboard cache, offline queue, pending deletes and the `seq` cursor of the signed-in account (as
/// Android's Room `ClipboardStore`), in one JSON file in Application Support. Only ciphertext and metadata are stored.
/// `wipe` bumps a generation number: a write that started before the wipe is refused, so nothing of a signed-out
/// account comes back.
public actor ClipboardStore {
    fileprivate struct File: Codable {
        var userId: String
        var events: [ClipboardEvent] = []
        var queue: [QueuedEvent] = []
        var deletes: [PendingDelete] = []
        var sync: ClipboardSyncState?
    }

    private let url: URL
    private var gen: Int64 = 1
    private var cache: File?

    public init(url: URL) { self.url = url }

    public func generation() -> Int64 { gen }

    private func load(_ userId: String) -> File {
        if let c = cache, c.userId == userId { return c }
        let f = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(File.self, from: $0) }
        let file = (f?.userId == userId ? f : nil) ?? File(userId: userId)
        cache = file
        return file
    }

    private func save(_ f: File) throws {
        cache = f
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(f).write(to: url, options: [.atomic])
    }

    public func snapshot(_ userId: String) -> ClipboardStoreSnapshot {
        let f = load(userId)
        return ClipboardStoreSnapshot(
            events: f.events,
            queue: f.queue.sorted { $0.queuedAt < $1.queuedAt },
            deletes: f.deletes,
            sync: f.sync
        )
    }

    /// Applies `change` unless the store was wiped since `generation`; returns whether it was written.
    public func write(_ generation: Int64, _ userId: String, _ change: @Sendable (inout Editor) -> Void) throws -> Bool {
        guard generation == gen else { return false }
        var editor = Editor(file: load(userId))
        change(&editor)
        try save(editor.file)
        return true
    }

    public func wipe() {
        gen += 1
        cache = nil
        try? FileManager.default.removeItem(at: url)
    }

    /// The operations of one write (Android's ClipboardDao helpers).
    public struct Editor {
        fileprivate var file: File

        public mutating func replace(events: [ClipboardEvent], cursor: Int64, syncedAt: Int64) {
            file.events = events
            file.sync = ClipboardSyncState(cursor: cursor, syncedAt: syncedAt)
        }

        public mutating func advance(put: [ClipboardEvent], remove: [String], cursor: Int64, syncedAt: Int64) {
            putEvents(put)
            removeEvents(remove)
            file.sync = ClipboardSyncState(cursor: cursor, syncedAt: syncedAt)
        }

        public mutating func putEvents(_ events: [ClipboardEvent]) {
            for e in events {
                if let i = file.events.firstIndex(where: { $0.eventId == e.eventId }) { file.events[i] = e } else { file.events.append(e) }
            }
        }

        public mutating func removeEvents(_ ids: [String]) {
            let drop = Set(ids)
            file.events.removeAll { drop.contains($0.eventId) }
        }

        public mutating func enqueue(_ q: QueuedEvent) {
            if let i = file.queue.firstIndex(where: { $0.eventId == q.eventId }) { file.queue[i] = q } else { file.queue.append(q) }
        }

        public mutating func dequeue(_ id: String) { file.queue.removeAll { $0.eventId == id } }

        public mutating func markDeleted(_ items: [PendingDelete]) {
            let ids = Set(items.map(\.eventId))
            file.queue.removeAll { ids.contains($0.eventId) }
            file.events.removeAll { ids.contains($0.eventId) }
            for d in items {
                if let i = file.deletes.firstIndex(where: { $0.eventId == d.eventId }) { file.deletes[i] = d }
                else { file.deletes.append(d) }
            }
        }

        public mutating func forgetDelete(_ id: String) { file.deletes.removeAll { $0.eventId == id } }
    }
}
