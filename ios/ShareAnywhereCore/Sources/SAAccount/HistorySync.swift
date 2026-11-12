import Foundation
import SAStore

/// Per-account history sync bookkeeping (the Web's AccountSyncMeta, Android's `HistoryMeta`): pull cursor, uploaded
/// entries, deletions waiting for the network, the one-time import, and the unreadable-entry retry point. No keys and no
/// plaintext beyond ids.
public struct HistoryMeta: Codable, Sendable, Equatable {
    public var userId: String
    public var cursor: Int64 = 0
    public var uploaded: [String: String] = [:]
    public var pendingDeletes: [String] = []
    public var pendingClear = false
    public var importPending = false
    public var pushSince: Int64 = 0
    public var retrySeq: Int64?
    public var retryVersions: [Int] = []

    public init(userId: String, pushSince: Int64 = 0) {
        self.userId = userId
        self.pushSince = pushSince
    }
}

/// Where `HistoryMeta` lives (a JSON file in Application Support); erased with the keys when the device leaves the account.
public actor HistoryMetaStore {
    private let url: URL
    private let clock: @Sendable () -> Int64

    public init(url: URL, clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.url = url
        self.clock = clock
    }

    public func get(_ userId: String) -> HistoryMeta {
        if let data = try? Data(contentsOf: url), let m = try? JSONDecoder().decode(HistoryMeta.self, from: data),
           m.userId == userId { return m }
        return HistoryMeta(userId: userId, pushSince: clock())
    }

    public func put(_ meta: HistoryMeta) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(meta).write(to: url, options: [.atomic])
    }

    public func wipe() { try? FileManager.default.removeItem(at: url) }
}

/// The local History operations sync needs.
public protocol LocalHistory: Sendable {
    func list() async throws -> [SAStore.HistoryEntry]
    func add(_ entry: SAStore.HistoryEntry) async throws -> Bool
    /// Removes without telling the sync handler (the change came from the account).
    func removeLocal(_ id: String) async throws
}

extension HistoryStore: LocalHistory {}

public struct SyncResult: Sendable, Equatable {
    public var pushed = 0
    public var pulled = 0
    public var removed = 0
    public var unreadable = 0
}

/// Encrypted cloud history sync (PRD §2 History; docs/API.md §2.4), the iOS port of the Web's historySync.ts and
/// Android's `HistorySync`: the same entry ids, JSON payload and rules, so entries move between all three clients.
public enum HistorySync {
    /// Local id of an entry pulled from the account.
    public static let syncPrefix = "sync:"

    public static func syncedID(_ entryID: String) -> String { syncPrefix + entryID }

    /// Server `entry_id` for a local entry: SHA-256 of `<local id>|<device id>`, shaped as a version-8 UUID.
    public static func entryUUID(localID: String, deviceID: String) -> String {
        Items.itemID(fromBytes: Primitives.sha256(Array("\(localID)|\(deviceID)".utf8)))
    }

    /// What is uploaded: the entry without local-only fields, with the Web's field names.
    public static func payload(_ e: SAStore.HistoryEntry) -> String {
        var o: [String: JSONValue] = [
            "direction": .string(e.direction.rawValue), "title": .string(e.title), "fileCount": .number(Double(e.fileCount)),
            "totalBytes": .number(Double(e.totalBytes)), "peer": .string(e.peer), "status": .string(e.status.rawValue),
            "createdAt": .number(Double(e.createdAt))
        ]
        if let t = e.transferredBytes { o["transferredBytes"] = .number(Double(t)) }
        if let p = e.peers { o["peers"] = .array(p.map(JSONValue.string)) }
        if let files = e.files {
            o["files"] = .array(files.map { f in
                var fo: [String: JSONValue] = ["name": .string(f.name), "size": .number(Double(f.size))]
                if let t = f.transferredBytes { fo["transferredBytes"] = .number(Double(t)) }
                return .object(fo)
            })
        }
        if let r = e.route { o["route"] = .string(r.rawValue) }
        if let s = e.startedAt { o["startedAt"] = .number(Double(s)) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(o)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    private static func str(_ o: [String: JSONValue], _ k: String, max: Int = 1024) -> String? {
        if case let .string(s)? = o[k], s.count <= max { return s }
        return nil
    }

    private static func num(_ o: [String: JSONValue], _ k: String) -> Int64? {
        if case let .number(n)? = o[k], n.isFinite, n >= 0, n <= Double(Int64.max) { return Int64(n) }
        return nil
    }

    /// Validates a decrypted entry: only known fields with sane types reach History.
    public static func parseEntry(_ text: String, id: String) -> SAStore.HistoryEntry? {
        guard let data = text.data(using: .utf8), let raw = try? JSONDecoder().decode([String: JSONValue].self, from: data),
              let direction = str(raw, "direction").flatMap(Direction.init(rawValue:)),
              let status = str(raw, "status").flatMap(HistoryStatus.init(rawValue:)),
              let title = str(raw, "title"), let peer = str(raw, "peer"),
              let fileCount = num(raw, "fileCount"), let totalBytes = num(raw, "totalBytes"),
              let createdAt = num(raw, "createdAt") else { return nil }
        var peers: [String]?
        if case let .array(a)? = raw["peers"], a.count <= 5 {
            let names = a.compactMap { v -> String? in if case let .string(s) = v, s.count <= 120 { return s }; return nil }
            if names.count == a.count { peers = names }
        }
        var files: [HistoryFile]?
        if case let .array(a)? = raw["files"], a.count <= 1000 {
            files = a.compactMap { v -> HistoryFile? in
                guard case let .object(f) = v, let name = str(f, "name"), let size = num(f, "size") else { return nil }
                return HistoryFile(name: name, size: size, transferredBytes: num(f, "transferredBytes"))
            }
        }
        return SAStore.HistoryEntry(
            id: id, direction: direction, title: title, fileCount: Int(min(fileCount, Int64(Int32.max))), totalBytes: totalBytes,
            transferredBytes: num(raw, "transferredBytes"), peer: peer, status: status, createdAt: createdAt, peers: peers, files: files,
            route: str(raw, "route").flatMap(HistoryRoute.init(rawValue:)), startedAt: num(raw, "startedAt")
        )
    }

    public struct Deps: Sendable {
        public var api: any HistoryEndpoints
        public var keys: any KeyStore
        public var history: any LocalHistory
        public var meta: HistoryMetaStore
        public var userId: String
        public var deviceId: String
        /// Account-wide `history_sync`. Off: only a pending import uploads, nothing is pulled.
        public var enabled: Bool
        public var deviceNames: [String: String] = [:]
        /// Runs a key check after `409 key_version_conflict`; the upload is retried once.
        public var onKeyConflict: (@Sendable () async -> Void)?

        public init(
            api: any HistoryEndpoints, keys: any KeyStore, history: any LocalHistory, meta: HistoryMetaStore, userId: String,
            deviceId: String,
            enabled: Bool, deviceNames: [String: String] = [:], onKeyConflict: (@Sendable () async -> Void)? = nil
        ) {
            self.api = api
            self.keys = keys
            self.history = history
            self.meta = meta
            self.userId = userId
            self.deviceId = deviceId
            self.enabled = enabled
            self.deviceNames = deviceNames
            self.onKeyConflict = onKeyConflict
        }
    }

    private static func flushDeletes(
        _ api: any HistoryEndpoints,
        _ meta: inout HistoryMeta,
        save: (HistoryMeta) async throws -> Void
    ) async throws {
        if meta.pendingClear {
            try await api.clearHistory()
            meta.pendingClear = false
            meta.pendingDeletes = []
            try await save(meta)
        }
        while let id = meta.pendingDeletes.first {
            do { try await api.deleteHistoryEntry(id) } catch let e as APIError where e.status == 404 {}
            meta.pendingDeletes.removeFirst()
            try await save(meta)
        }
    }

    private static func subkey(_ keys: any KeyStore, _ v: Int) async throws -> [UInt8] {
        try await ADK.subkey(keys.adk(v), label: ADK.history)
    }

    private static func pushOnce(_ d: Deps, _ meta: inout HistoryMeta, _ count: inout Int) async throws {
        let v = try await d.keys.current()
        if v == 0 { return }
        let key = try await subkey(d.keys, v)
        for entry in try await d.history.list() {
            if entry.id.hasPrefix(syncPrefix) || meta.uploaded[entry.id] != nil { continue }
            if !meta.importPending, entry.createdAt < meta.pushSince { continue }
            let entryID = entryUUID(localID: entry.id, deviceID: d.deviceId)
            let item = try Items.encrypt(subkey: key, id: entryID, keyVersion: v, Array(payload(entry).utf8))
            _ = try await d.api.addHistoryEntry(HistoryEntryRequest(
                entryId: entryID, keyVersion: v, nonce: B64u.encode(item.nonce), ciphertext: B64u.encode(item.ciphertext)
            ))
            meta.uploaded[entry.id] = entryID
            count += 1
        }
        meta.importPending = false
    }

    private static func push(_ d: Deps, _ meta: inout HistoryMeta) async throws -> Int {
        if !d.enabled, !meta.importPending { return 0 }
        var count = 0
        var attempt = 0
        while true {
            do {
                try await pushOnce(d, &meta, &count)
                return count
            } catch let e as APIError where e.code == "key_version_conflict" && attempt == 0 && d.onKeyConflict != nil {
                attempt += 1
                await d.onKeyConflict?()
            }
        }
    }

    /// Entries skipped as unreadable are pulled again once the device holds a key version it lacked then.
    public static func rewindForNewKeys(_ meta: HistoryMeta, held: [Int]) -> HistoryMeta {
        guard let seq = meta.retrySeq else { return meta }
        if !held.contains(where: { !meta.retryVersions.contains($0) }) { return meta }
        var m = meta
        m.cursor = min(m.cursor, max(0, seq - 1))
        m.retrySeq = nil
        m.retryVersions = []
        return m
    }

    private static func pull(_ d: Deps, _ meta: inout HistoryMeta) async throws -> (pulled: Int, removed: Int, unreadable: Int) {
        var out = (pulled: 0, removed: 0, unreadable: 0)
        if !d.enabled { return out }
        let held = try await d.keys.versions()
        meta = rewindForNewKeys(meta, held: held)
        func skipped(_ seq: Int64) {
            out.unreadable += 1
            meta.retrySeq = meta.retrySeq.map { min($0, seq) } ?? seq
            meta.retryVersions = held
        }
        for _ in 0 ..< 50 {
            let res = try await d.api.historyEntries(after: meta.cursor, limit: 200)
            if res.entries.isEmpty { return out }
            let mine = Dictionary(meta.uploaded.map { ($0.value, $0.key) }, uniquingKeysWith: { a, _ in a })
            for e in res.entries {
                let local = mine[e.entryId]
                if e.deleted {
                    if let local {
                        try await d.history.removeLocal(local)
                        meta.uploaded[local] = nil
                        out.removed += 1
                    }
                    try await d.history.removeLocal(syncedID(e.entryId))
                    continue
                }
                guard local == nil, e.originDeviceId != d.deviceId, let nonce = e.nonce, let ct = e.ciphertext else { continue }
                if try await !d.keys.has(e.keyVersion) {
                    skipped(e.seq)
                    continue
                }
                var text: String?
                if let key = try? await subkey(d.keys, e.keyVersion),
                   let n = try? B64u.decode(nonce), let c = try? B64u.decode(ct),
                   let plain = try? Items.decrypt(
                       subkey: key,
                       id: e.entryId,
                       keyVersion: e.keyVersion,
                       EncryptedItem(nonce: n, ciphertext: c)
                   ) {
                    text = String(decoding: plain, as: UTF8.self)
                }
                guard var parsed = text.flatMap({ parseEntry($0, id: syncedID(e.entryId)) }) else {
                    skipped(e.seq)
                    continue
                }
                parsed.origin = d.deviceNames[e.originDeviceId]
                _ = try await d.history.add(parsed)
                out.pulled += 1
            }
            meta.cursor = res.nextAfter
            try await d.meta.put(meta)
        }
        return out
    }

    /// One pass: deletions made offline, uploads (new entries while sync is on, every one once after "Copy this device's
    /// transfer history"), then everything after the cursor. Bookkeeping that succeeded is saved before an error propagates.
    public static func sync(_ d: Deps) async throws -> SyncResult {
        var meta = await d.meta.get(d.userId)
        do {
            let store = d.meta
            try await flushDeletes(d.api, &meta) { try await store.put($0) }
            let pushed = try await push(d, &meta)
            let p = try await pull(d, &meta)
            try await d.meta.put(meta)
            return SyncResult(pushed: pushed, pulled: p.pulled, removed: p.removed, unreadable: p.unreadable)
        } catch {
            try? await d.meta.put(meta)
            throw error
        }
    }

    /// A local deletion tombstones the matching server entry (queued when offline).
    public static func deleteSynced(
        _ api: any HistoryEndpoints,
        _ store: HistoryMetaStore,
        userId: String,
        localIDs: [String]
    ) async throws {
        var meta = await store.get(userId)
        let remote = localIDs.compactMap { id in id.hasPrefix(syncPrefix) ? String(id.dropFirst(syncPrefix.count)) : meta.uploaded[id] }
        for id in localIDs {
            meta.uploaded[id] = nil
        }
        for r in remote where !meta.pendingDeletes.contains(r) {
            meta.pendingDeletes.append(r)
        }
        try await store.put(meta)
        do {
            try await flushDeletes(api, &meta) { try await store.put($0) }
        } catch {
            try? await store.put(meta)
            throw error
        }
        try await store.put(meta)
    }

    /// "Clear all" while syncing tombstones the whole account history (queued when offline).
    public static func clearSynced(_ api: any HistoryEndpoints, _ store: HistoryMetaStore, userId: String) async throws {
        var meta = await store.get(userId)
        meta.pendingClear = true
        meta.uploaded = [:]
        try await store.put(meta)
        do {
            try await flushDeletes(api, &meta) { try await store.put($0) }
        } catch {
            try? await store.put(meta)
            throw error
        }
        try await store.put(meta)
    }
}
