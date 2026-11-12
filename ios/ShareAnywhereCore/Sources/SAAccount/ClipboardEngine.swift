import Foundation

/// The keys the engine needs: the versions held and the clipboard subkey of one (docs/CLIPBOARD_PROTOCOL.md §1.2).
public struct KeySource: Sendable {
    public var current: @Sendable () async throws -> Int
    public var versions: @Sendable () async throws -> [Int]
    public var clipboardKey: @Sendable (Int) async throws -> [UInt8]

    public init(
        current: @escaping @Sendable () async throws -> Int, versions: @escaping @Sendable () async throws -> [Int],
        clipboardKey: @escaping @Sendable (Int) async throws -> [UInt8]
    ) {
        self.current = current
        self.versions = versions
        self.clipboardKey = clipboardKey
    }

    public static func of(_ store: any KeyStore) -> KeySource {
        KeySource(
            current: { try await store.current() }, versions: { try await store.versions() },
            clipboardKey: { v in try await ADK.subkey(store.adk(v), label: ADK.clipboard) }
        )
    }
}

/// A timeline row. `text` is nil when this device cannot decrypt it (a key version it does not hold).
public struct ClipItem: Sendable, Equatable, Identifiable {
    public var id: String
    /// Nil while the event waits in the offline queue.
    public var seq: Int64?
    public var origin: String
    public var createdAt: Int64
    public var expiresAt: Int64?
    public var size: Int
    public var keyVersion: Int
    public var text: String?
    public var pending: Bool
    /// Arrived from another device while the app was open, and not copied yet ("New").
    public var incoming: Bool
}

/// A capture skipped as possibly sensitive (automatic capture only). Never stored or sent.
public struct SkippedNotice: Sendable, Equatable, Identifiable {
    public var id: String
    public var at: Int64
    public var kind: SensitiveKind
}

public enum SendError: String, Sendable { case offline, key, rateLimited, error, rejected }
public enum LoadError: String, Sendable { case offline, error }

public struct ClipboardSnapshot: Sendable, Equatable {
    public var loaded = false
    /// A refresh from the server succeeded since the engine started (an empty timeline is then really empty).
    public var synced = false
    public var loadError: LoadError?
    public var syncing = false
    public var items: [ClipItem] = []
    public var skipped: [SkippedNotice] = []
    public var settings: ClipboardSettings?
    public var settingsError = false
    public var queued = 0
    public var sendError: SendError?
    public var unreadable = 0
    public init() {}
}

public enum CaptureSource: Sendable { case manual, auto }

/// Why a capture stayed in the queue, for the toast.
public enum QueueReason: Sendable { case offline, busy, rateLimited, key, paused, pending }

public enum CaptureResult: Sendable, Equatable {
    case synced(String)
    case queued(String, QueueReason)
    case removed(String)
    case sensitive(SensitiveKind)
    case duplicate, empty, tooLarge, paused, notReady
}

/// A value the engine writes and the UI watches.
public final class ValueCell<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Value
    private var watchers: [UUID: AsyncStream<Value>.Continuation] = [:]

    public init(_ value: Value) { current = value }

    public var value: Value { lock.withLockedValue { current } }

    public func set(_ value: Value) {
        let all = lock.withLockedValue { () -> [AsyncStream<Value>.Continuation] in
            current = value
            return Array(watchers.values)
        }
        for c in all {
            c.yield(value)
        }
    }

    /// The current value, then every change (newest wins when the reader is slow).
    public func values() -> AsyncStream<Value> {
        let id = UUID()
        var continuation: AsyncStream<Value>.Continuation!
        let stream = AsyncStream<Value>(bufferingPolicy: .bufferingNewest(1)) { continuation = $0 }
        let c = continuation!
        lock.withLockedValue {
            watchers[id] = c
            c.yield(current)
        }
        c.onTermination = { [weak self] _ in self?.lock.withLockedValue { self?.watchers[id] = nil } }
        return stream
    }
}

private enum Outcome { case synced, removed, rejected }
private enum SendOutcome { case ok, resync, rejected, stop, halt }
private enum DeleteOutcome { case ok, stop, later, halt }

/// Clipboard Sync for one account on this device (docs/CLIPBOARD_PROTOCOL.md §2, PRD §7.4–§7.6): the iOS port of the
/// Web's engine.ts and Android's `ClipboardEngine` with the same protocol rules. Holds the decrypted timeline in memory
/// only; the encrypted cache, the offline queue, the pending deletes and the `seq` cursor live in `ClipboardStore`.
public actor ClipboardEngine {
    public static let retryMinMs: Int64 = 5000
    public static let retryMaxMs: Int64 = 60000
    /// A cursor older than this is not followed: tombstones are swept after 7 days (one day of margin).
    public static let staleCursorMs: Int64 = 6 * 86_400_000
    /// How long a pending delete of a queued capture is kept after a 404 (§2.9).
    public static let deleteGraceMs: Int64 = 120_000
    public static let maxPayloadBytes = 65536
    public static let maxEvents = 100
    static let maxPages = 50

    public nonisolated let state = ValueCell(ClipboardSnapshot())
    public let userId: String
    public let deviceId: String
    private let api: any ClipboardEndpoints
    private let keys: KeySource
    private let store: ClipboardStore
    private let onKeyConflict: (@Sendable () async -> Void)?
    private let now: @Sendable () -> Int64
    private let uuid: @Sendable () -> String
    private let sleep: @Sendable (Int64) async -> Void

    private var events: [String: ClipboardEvent] = [:]
    private var queued: [String: QueuedEvent] = [:]
    private var texts: [String: String?] = [:]
    private var incoming: Set<String> = []
    private var skipped: [SkippedNotice] = []
    private var settings: ClipboardSettings?
    private var settingsError = false
    private var loaded = false
    private var synced = false
    private var loadError: LoadError?
    private var sendError: SendError?
    private var refreshing: Task<Void, Never>?
    private var refreshAgain = false
    private var flushing: Task<Void, Never>?
    private var flushAgain = false
    private var tombstoned: Set<String> = []
    private var attempted: Set<String> = []
    private var deletedHere: Set<String> = []
    private var pendingDeletes: [String: PendingDelete] = [:]
    private var outcomes: [String: Outcome?] = [:]
    private var clearing = false
    private var cursor: Int64?
    private var syncedAt: Int64?
    private var retryTask: Task<Void, Never>?
    private var retryAt: Int64 = 0
    private var refreshTask: Task<Void, Never>?
    private var retryDelay = ClipboardEngine.retryMinMs
    private var lastText: String?
    private var lastSkipped: String?
    private var stopped = false
    private var generation: Int64?
    private var wiped = false

    public init(
        api: any ClipboardEndpoints, keys: KeySource, store: ClipboardStore, userId: String, deviceId: String,
        onKeyConflict: (@Sendable () async -> Void)? = nil,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        uuid: @escaping @Sendable () -> String = { Items.newItemID() },
        sleep: @escaping @Sendable (Int64) async -> Void = { ms in try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000) }
    ) {
        self.api = api
        self.keys = keys
        self.store = store
        self.userId = userId
        self.deviceId = deviceId
        self.onKeyConflict = onKeyConflict
        self.now = now
        self.uuid = uuid
        self.sleep = sleep
    }

    static func parseTime(_ iso: String?) -> Int64? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return Int64(d.timeIntervalSince1970 * 1000) }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso).map { Int64($0.timeIntervalSince1970 * 1000) }
    }

    private func emit() {
        if stopped { return }
        state.set(build())
    }

    private func build() -> ClipboardSnapshot {
        let t = now()
        var items: [ClipItem] = []
        for q in queued.values where events[q.eventId] == nil {
            items.append(ClipItem(
                id: q.eventId, seq: nil, origin: deviceId, createdAt: q.queuedAt, expiresAt: nil, size: q.payloadSize,
                keyVersion: q.keyVersion,
                text: texts[q.eventId] ?? nil, pending: true, incoming: false
            ))
        }
        let live = events.values.filter { e in ClipboardEngine.parseTime(e.expiresAt).map { $0 > t } ?? true }
            .sorted { $0.seq > $1.seq }.prefix(ClipboardEngine.maxEvents)
        for e in live {
            items.append(ClipItem(
                id: e.eventId, seq: e.seq, origin: e.originDeviceId, createdAt: ClipboardEngine.parseTime(e.createdAt) ?? t,
                expiresAt: ClipboardEngine.parseTime(e.expiresAt), size: e.payloadSize, keyVersion: e.keyVersion,
                text: texts[e.eventId] ?? nil,
                pending: false, incoming: incoming.contains(e.eventId)
            ))
        }
        items.sort { a, b in a.pending != b.pending ? a.pending : a.createdAt > b.createdAt }
        var s = ClipboardSnapshot()
        s.loaded = loaded
        s.synced = synced
        s.loadError = loadError
        s.syncing = refreshing != nil
        s.items = items
        s.skipped = skipped
        s.settings = settings
        s.settingsError = settingsError
        s.queued = queued.count
        s.sendError = sendError
        s.unreadable = items.filter { $0.text == nil }.count
        return s
    }

    /// Writes to the store unless stopped or wiped since start. Storage errors are ignored (the server is the truth).
    @discardableResult
    private func persist(_ change: @escaping @Sendable (inout ClipboardStore.Editor) -> Void) async -> Bool {
        if stopped || wiped { return false }
        guard let gen = generation else { return false }
        let wrote = try? await store.write(gen, userId, change)
        if wrote == false { wiped = true }
        return wrote == true
    }

    private func settle(_ id: String, _ outcome: Outcome) {
        if let entry = outcomes[id], entry == nil { outcomes[id] = outcome }
    }

    /// Reads the cache and the queue, then refreshes from the server, loads the settings and sends what is queued.
    public func start() async {
        generation = await store.generation()
        let snap = await store.snapshot(userId)
        let deleted = Set(snap.deletes.map(\.eventId))
        for q in snap.queue where !deleted.contains(q.eventId) {
            queued[q.eventId] = q
            attempted.insert(q.eventId)
        }
        await adopt(snap)
        loaded = true
        emit()
        async let r: Void = refresh()
        async let s: Void = loadSettings()
        _ = await (r, s)
        Task { await self.flush() }
    }

    private func adopt(_ snap: ClipboardStoreSnapshot) async {
        for d in snap.deletes {
            if pendingDeletes[d.eventId] == nil { pendingDeletes[d.eventId] = d }
            deletedHere.insert(d.eventId)
        }
        var next: [String: ClipboardEvent] = [:]
        for e in snap.events where !e.deleted && !deletedHere.contains(e.eventId) {
            next[e.eventId] = e
        }
        events = next
        cursor = snap.sync?.cursor
        syncedAt = snap.sync?.syncedAt
        for id in queued.keys where events[id] != nil {
            await acked(id)
        }
        await decryptMissing()
    }

    public func stop() {
        stopped = true
        retryTask?.cancel()
        refreshTask?.cancel()
    }

    private func decrypt(_ id: String, _ keyVersion: Int, _ nonce: String, _ ciphertext: String) async -> String? {
        guard let held = try? await keys.versions(), held.contains(keyVersion), let key = try? await keys.clipboardKey(keyVersion),
              let n = try? B64u.decode(nonce), let c = try? B64u.decode(ciphertext),
              let plain = try? Items.decrypt(subkey: key, id: id, keyVersion: keyVersion, EncryptedItem(nonce: n, ciphertext: c))
        else { return nil }
        return String(decoding: plain, as: UTF8.self)
    }

    private func decryptMissing(retryLocked: Bool = false) async {
        for e in Array(events.values) {
            guard let nonce = e.nonce, let ct = e.ciphertext else { continue }
            if let have = texts[e.eventId], !(retryLocked && have == nil) { continue }
            texts[e.eventId] = await decrypt(e.eventId, e.keyVersion, nonce, ct)
        }
        for q in Array(queued.values) {
            if let have = texts[q.eventId], !(retryLocked && have == nil) { continue }
            texts[q.eventId] = await decrypt(q.eventId, q.keyVersion, q.nonce, q.ciphertext)
        }
    }

    /// A key check stored new versions: locked rows are tried again, and the queue is sent.
    public func keysChanged() async {
        await decryptMissing(retryLocked: true)
        if sendError == .key { sendError = nil }
        emit()
        Task { await self.flush() }
    }

    /// Follows the account's cursor until no newer event is left; the first time (or after a stale cursor) it loads the
    /// live timeline. Concurrent calls coalesce into one more pass.
    public func refresh() async {
        if let r = refreshing {
            refreshAgain = true
            await r.value
            return
        }
        let task = Task {
            repeat {
                self.refreshAgain = false
                await self.pull()
            } while self.refreshAgain && !self.stopped
        }
        refreshing = task
        emit()
        await task.value
        refreshing = nil
        emit()
    }

    private func pull() async {
        do {
            var from = cursor
            // Tombstones are kept 7 days (§2.5): an older cursor may have missed deletions, so reload the live timeline.
            if from != nil, syncedAt == nil || now() - (syncedAt ?? 0) > ClipboardEngine.staleCursorMs { from = nil }
            if from == nil {
                let h = try await api.history(limit: ClipboardEngine.maxEvents)
                let all = h.events.filter { !$0.deleted }
                let live = all.filter { !deletedHere.contains($0.eventId) }
                let t = now()
                await persist { $0.replace(events: live, cursor: h.cursor, syncedAt: t) }
                events = Dictionary(live.map { ($0.eventId, $0) }, uniquingKeysWith: { a, _ in a })
                cursor = h.cursor
                syncedAt = t
                if live.count < all.count { await deleteAgain(all.filter { deletedHere.contains($0.eventId) }.map(\.eventId)) }
                for id in queued.keys where events[id] != nil {
                    await acked(id)
                }
            }
            var page = 0
            while page < ClipboardEngine.maxPages, !stopped {
                page += 1
                guard let start = cursor else { break }
                let res = try await api.events(cursor: start, limit: 100)
                var put: [ClipboardEvent] = []
                var remove: [String] = []
                var again: [String] = []
                for e in res.events {
                    if e.deleted {
                        remove.append(e.eventId)
                        events[e.eventId] = nil
                        incoming.remove(e.eventId)
                        tombstoned.insert(e.eventId)
                        // Deleted elsewhere while still queued here (its create landed, the answer was lost): dropped.
                        if queued[e.eventId] != nil { await dropQueued(e.eventId, .synced) }
                        // A tombstone confirms a pending delete.
                        if pendingDeletes[e.eventId] != nil { await forgetDelete(e.eventId) }
                        texts[e.eventId] = nil
                        continue
                    }
                    if deletedHere.contains(e.eventId) {
                        remove.append(e.eventId)
                        again.append(e.eventId)
                        continue
                    }
                    put.append(e)
                    let fresh = events[e.eventId] == nil && queued[e.eventId] == nil
                    events[e.eventId] = e
                    if fresh, loaded, e.originDeviceId != deviceId { incoming.insert(e.eventId) }
                    if queued[e.eventId] != nil { await acked(e.eventId) }
                }
                let next = max(start, res.nextCursor, res.events.map(\.seq).max() ?? start)
                let t = now()
                let wrote = await persist { [put, remove] in $0.advance(put: put, remove: remove, cursor: next, syncedAt: t) }
                if !again.isEmpty { await deleteAgain(again) }
                cursor = next
                if wrote { syncedAt = t }
                if res.events.isEmpty || next <= start { break }
            }
            await decryptMissing()
            loadError = nil
            synced = true
        } catch let e as APIError {
            if e.status == 429 {
                scheduleRefresh(Int64(e.retryAfterSeconds ?? 5) * 1000)
                return
            }
            loadError = .error
        } catch is NetworkError {
            loadError = .offline
        } catch {
            loadError = .error
        }
    }

    private func scheduleRefresh(_ ms: Int64) {
        if stopped || refreshTask != nil { return }
        let wait = min(ClipboardEngine.retryMaxMs, max(1000, ms))
        refreshTask = Task {
            await self.sleep(wait)
            await self.refreshFired()
        }
    }

    private func refreshFired() async {
        refreshTask = nil
        if Task.isCancelled { return }
        await refresh()
    }

    private func acked(_ id: String) async {
        settle(id, .synced)
        queued[id] = nil
        attempted.remove(id)
        await persist { $0.dequeue(id) }
    }

    private func dropQueued(_ id: String, _ outcome: Outcome) async {
        settle(id, outcome)
        queued[id] = nil
        attempted.remove(id)
        await persist { $0.dequeue(id) }
    }

    private func markDeleted(_ ids: [String], due: Int64) async {
        if ids.isEmpty { return }
        let t = now()
        let items = ids.map { PendingDelete(userId: userId, eventId: $0, at: pendingDeletes[$0]?.at ?? t, due: due) }
        for d in items {
            let id = d.eventId
            settle(id, .removed)
            pendingDeletes[id] = d
            deletedHere.insert(id)
            queued[id] = nil
            attempted.remove(id)
            events[id] = nil
            texts[id] = nil
            incoming.remove(id)
        }
        await persist { $0.markDeleted(items) }
    }

    private func deleteAgain(_ ids: [String]) async {
        await markDeleted(ids, due: now())
        Task { await self.flush() }
    }

    private func forgetDelete(_ id: String) async {
        pendingDeletes[id] = nil
        await persist { $0.forgetDelete(id) }
    }

    public func loadSettings() async {
        let loadedSettings = try? await api.settings()
        if let loadedSettings {
            settings = loadedSettings
            settingsError = false
        } else {
            settingsError = true
        }
        emit()
    }

    /// `CLIPBOARD_SETTINGS_UPDATED` from another device (metadata only).
    public func applySettings(_ s: ClipboardSettings) {
        let resumed = settings?.paused == true && !s.paused
        settings = s
        settingsError = false
        emit()
        if resumed { Task { await self.flush() } }
    }

    public func saveSettings(_ next: ClipboardSettings) async throws -> ClipboardSettings {
        let stored = try await api.saveSettings(next)
        applySettings(stored)
        return stored
    }

    /// The newest text seen on the clipboard (captured, or written by Copy): repeats are not synced.
    public func noteClipboardText(_ text: String) { lastText = text }

    private func isDuplicate(_ text: String, _ source: CaptureSource) -> Bool {
        if build().items.first(where: { $0.text != nil })?.text == text { return true }
        return source != .manual && (text == lastText || text == lastSkipped)
    }

    /// Encrypts and sends one capture. Manual Sync passes `force` after "Sync anyway" on a capture skipped as possibly
    /// sensitive. Automatic captures that look sensitive, or that iOS `detectPatterns` `flagged`, are skipped and noted
    /// (never stored).
    public func capture(_ text: String, source: CaptureSource, force: Bool = false, flagged: Bool = false) async -> CaptureResult {
        if stopped { return .notReady }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
        if settings?.paused == true { return .paused }
        if text.utf8.count > ClipboardEngine.maxPayloadBytes { return .tooLarge }
        if isDuplicate(text, source) { return .duplicate }
        let skipSensitive = settings?.sensitiveSkip ?? true
        let sensitive: SensitiveKind? = force ? nil : flagged ? .flagged : skipSensitive ? Sensitive.kind(text) : nil
        if let sensitive {
            if source != .manual {
                lastSkipped = text
                skipped = Array(([SkippedNotice(id: uuid(), at: now(), kind: sensitive)] + skipped).prefix(20))
                emit()
            }
            return .sensitive(sensitive)
        }
        guard let version = try? await keys.current(), version > 0,
              let key = try? await keys.clipboardKey(version) else { return .notReady }
        let id = uuid().lowercased()
        let bytes = Array(text.utf8)
        guard let enc = try? Items.encrypt(subkey: key, id: id, keyVersion: version, bytes) else { return .notReady }
        let item = QueuedEvent(
            userId: userId, eventId: id, keyVersion: version, nonce: B64u.encode(enc.nonce), ciphertext: B64u.encode(enc.ciphertext),
            payloadSize: bytes.count, queuedAt: now()
        )
        lastText = text
        texts[id] = text
        queued[id] = item
        outcomes[id] = .some(nil)
        await persist { $0.enqueue(item) }
        emit()
        await flush()
        defer { outcomes[id] = nil }
        if queued[id] != nil { return .queued(id, queueReason()) }
        switch outcomes[id] ?? nil {
        case .synced: return .synced(id)
        case .removed: return .removed(id)
        case .rejected: return .tooLarge
        case nil: return .notReady
        }
    }

    private func queueReason() -> QueueReason {
        if settings?.paused == true { return .paused }
        switch sendError {
        case .offline: return .offline
        case .rateLimited: return .rateLimited
        case .error: return .busy
        case .key: return .key
        default: return .pending
        }
    }

    /// Sends queued events in capture order (idempotent by `event_id`). A call during a pass causes one more pass.
    public func flush() async {
        if let f = flushing {
            flushAgain = true
            await f.value
            return
        }
        let task = Task {
            var resync = false
            repeat {
                self.flushAgain = false
                if await self.sendAll() { resync = true }
            } while self.flushAgain && !self.stopped
            if resync, !self.stopped {
                Task { await self.refresh() }
            }
        }
        flushing = task
        await task.value
        flushing = nil
        emit()
    }

    private func armTimer(_ ms: Int64) {
        if stopped { return }
        let at = now() + ms
        if retryTask != nil {
            if retryAt <= at { return }
            retryTask?.cancel()
        }
        retryAt = at
        retryTask = Task {
            await self.sleep(ms)
            await self.timerFired()
        }
    }

    private func timerFired() async {
        retryTask = nil
        if Task.isCancelled { return }
        await flush()
    }

    private func scheduleRetry() {
        if queued.isEmpty, pendingDeletes.isEmpty { return }
        let d = retryDelay
        if retryTask != nil, retryAt <= now() + d { return }
        retryDelay = min(ClipboardEngine.retryMaxMs, retryDelay * 2)
        armTimer(d)
    }

    private func scheduleDue() {
        guard let next = pendingDeletes.values.map(\.due).min() else { return }
        armTimer(max(1000, next - now()))
    }

    private func sendDeletes() async -> (outcome: DeleteOutcome, sent: Bool, tried: Bool) {
        var sent = false, tried = false
        for d in pendingDeletes.values.sorted(by: { $0.at < $1.at }) {
            if stopped { return (.halt, sent, tried) }
            let id = d.eventId
            guard let current = pendingDeletes[id] else { continue }
            if current.due > now() { continue }
            tried = true
            do {
                try await api.remove(id)
                await forgetDelete(id)
                sent = true
            } catch is NetworkError {
                sendError = .offline
                return (.stop, sent, tried)
            } catch let e as APIError {
                switch e.status {
                case 404:
                    // Not on the server (yet): a create in flight may land later, so one last DELETE follows the grace.
                    let settleAt = current.at + ClipboardEngine.deleteGraceMs
                    if now() >= settleAt { await forgetDelete(id) } else { await markDeleted([id], due: settleAt) }
                case 401, 403: return (.halt, sent, tried)
                case 400: await forgetDelete(id)
                default:
                    if e.status == 429 { retryDelay = max(retryDelay, Int64(e.retryAfterSeconds ?? 5) * 1000) }
                    return (.later, sent, tried)
                }
            } catch {
                return (.later, sent, tried)
            }
        }
        return (.ok, sent, tried)
    }

    private func sendAll() async -> Bool {
        let del = await sendDeletes()
        var resync = del.sent
        switch del.outcome {
        case .stop:
            scheduleRetry()
            return resync
        case .halt: return resync
        default: break
        }
        if settings?.paused == true || clearing {
            if del.outcome == .later { scheduleRetry() } else { scheduleDue() }
            return resync
        }
        let pending = queued.values.sorted { $0.queuedAt < $1.queuedAt }
        var rejected = false
        for item in pending {
            if stopped || clearing { return resync }
            if queued[item.eventId] == nil { continue }
            let retry = attempted.contains(item.eventId)
            let outcome = await sendOne(item)
            switch outcome {
            case .stop:
                scheduleRetry()
                return resync
            case .halt: return resync
            default:
                if outcome == .rejected { rejected = true }
                if outcome == .resync || (outcome == .ok && retry) { resync = true }
            }
        }
        if !pending.isEmpty || del.tried { sendError = rejected ? .rejected : nil }
        if del.outcome == .later {
            scheduleRetry()
            return resync
        }
        retryDelay = ClipboardEngine.retryMinMs
        scheduleDue()
        return resync
    }

    private func sendOne(_ first: QueuedEvent) async -> SendOutcome {
        var item = first
        var attempt = 0
        while true {
            do {
                attempted.insert(item.eventId)
                let res = try await api.create(ClipboardEventRequest(
                    eventId: item.eventId, keyVersion: item.keyVersion, nonce: item.nonce, ciphertext: item.ciphertext,
                    payloadSize: item.payloadSize,
                    eventType: "TEXT", mimeType: "text/plain"
                ))
                let id = item.eventId
                let e = ClipboardEvent(
                    eventId: id, seq: res.seq, originDeviceId: deviceId, eventType: "TEXT", mimeType: "text/plain",
                    keyVersion: item.keyVersion,
                    nonce: item.nonce, ciphertext: item.ciphertext, payloadSize: item.payloadSize, createdAt: res.createdAt,
                    expiresAt: res.expiresAt,
                    deleted: false
                )
                if tombstoned.contains(id) {
                    // Deleted on another device meanwhile: acknowledged, but not a row again.
                    await dropQueued(id, .synced)
                    texts[id] = nil
                    emit()
                    return .ok
                }
                if deletedHere.contains(id) { return await ackDeleted(id) }
                if queued[id] == nil {
                    // A cursor pull already saw it (the server notifies before it answers the create).
                    settle(id, .synced)
                    attempted.remove(id)
                    return .ok
                }
                settle(id, .synced)
                events[id] = e
                queued[id] = nil
                attempted.remove(id)
                await persist {
                    $0.dequeue(id)
                    $0.putEvents([e])
                }
                emit()
                // A seq beyond the applied cursor may be a tombstone's, or one may follow it: follow the cursor now.
                if let c = cursor, e.seq <= c { return .ok }
                return .resync
            } catch is NetworkError {
                sendError = .offline
                return .stop
            } catch let e as APIError {
                if e.code == "key_version_conflict", attempt == 0, let onKeyConflict {
                    // The account rotated its key: pick it up, re-encrypt under the newest version, send once more.
                    await onKeyConflict()
                    if let next = await reencrypt(item) {
                        item = next
                        attempt += 1
                        continue
                    }
                }
                if e.code == "key_version_conflict" {
                    sendError = .key
                    return .halt
                }
                if e.code == "clipboard_paused" {
                    var s = settings ?? ClipboardSettings(paused: true, retentionDays: 7, sensitiveSkip: true)
                    s.paused = true
                    settings = s
                    Task { await self.loadSettings() }
                    return .halt
                }
                if e.status == 429 {
                    sendError = .rateLimited
                    retryDelay = max(retryDelay, Int64(e.retryAfterSeconds ?? 5) * 1000)
                    return .stop
                }
                if e.status == 413 || e.status == 400 {
                    // The server will never take this one: dropped instead of retried forever.
                    await dropQueued(item.eventId, .rejected)
                    texts[item.eventId] = nil
                    emit()
                    return .rejected
                }
                if e.status == 401 || e.status == 403 { return .halt }
                sendError = .error
                return .stop
            } catch {
                sendError = .error
                return .stop
            }
        }
    }

    private func ackDeleted(_ id: String) async -> SendOutcome {
        await markDeleted([id], due: now())
        flushAgain = true
        emit()
        return .ok
    }

    private func reencrypt(_ item: QueuedEvent) async -> QueuedEvent? {
        guard let version = try? await keys.current(), version > item.keyVersion else { return nil }
        var text = texts[item.eventId] ?? nil
        if text == nil { text = await decrypt(item.eventId, item.keyVersion, item.nonce, item.ciphertext) }
        guard let text, let key = try? await keys.clipboardKey(version),
              let enc = try? Items.encrypt(subkey: key, id: item.eventId, keyVersion: version, Array(text.utf8)) else { return nil }
        var next = item
        next.keyVersion = version
        next.nonce = B64u.encode(enc.nonce)
        next.ciphertext = B64u.encode(enc.ciphertext)
        queued[next.eventId] = next
        await persist { [next] in $0.enqueue(next) }
        return next
    }

    /// Deletes one event on every device. A queued one becomes a pending delete at once (it may have reached the
    /// server); a synced one is deleted on the server first (an error is thrown and the row stays).
    public func remove(_ id: String) async throws {
        if queued[id] != nil {
            await markDeleted([id], due: now())
            emit()
            await flush()
            Task { await self.refresh() }
            return
        }
        do { try await api.remove(id) } catch let e as APIError where e.status == 404 {}
        deletedHere.insert(id)
        events[id] = nil
        texts[id] = nil
        incoming.remove(id)
        await persist { $0.removeEvents([id]) }
        emit()
        Task { await self.refresh() }
    }

    /// Clears the account's clipboard history on every device. Captures queued when Clear was pressed are dropped and
    /// never sent after it (pending deletes for the grace period); a capture made after it is kept.
    public func clear() async throws {
        clearing = true
        let before = Array(queued.keys)
        var shown = Set(events.keys)
        do {
            while let f = flushing {
                await f.value
            }
            shown.formUnion(events.keys)
            try await api.clear()
        } catch {
            clearing = false
            Task { await self.flush() }
            throw error
        }
        await markDeleted(before, due: now() + ClipboardEngine.deleteGraceMs)
        clearing = false
        for id in shown {
            events[id] = nil
            incoming.remove(id)
            texts[id] = nil
        }
        await persist { [shown] in $0.removeEvents(Array(shown)) }
        emit()
        Task { await self.refresh() }
        Task { await self.flush() }
    }

    /// The user copied this row: no longer "New", and the clipboard now holds its text (not captured again).
    public func markCopied(_ id: String) {
        if let t = texts[id] ?? nil { lastText = t }
        if incoming.remove(id) != nil { emit() }
    }

    public func dismissSkipped(_ id: String) {
        skipped.removeAll { $0.id == id }
        emit()
    }
}
