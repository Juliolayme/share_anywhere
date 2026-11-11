package app.shareanywhere.clipboard

import app.shareanywhere.account.crypto.Adk
import app.shareanywhere.account.crypto.B64u
import app.shareanywhere.account.crypto.EncryptedItem
import app.shareanywhere.account.crypto.Items
import app.shareanywhere.account.crypto.KeyStore
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.ClipboardEvent
import app.shareanywhere.data.api.ClipboardEventRequest
import app.shareanywhere.data.api.ClipboardSettings
import app.shareanywhere.data.api.NetworkException
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The keys the engine needs: the versions held and the clipboard subkey of one (docs/CLIPBOARD_PROTOCOL.md §1.2). */
interface KeySource {
    suspend fun current(): Int

    suspend fun versions(): List<Int>

    suspend fun clipboardKey(version: Int): ByteArray

    companion object {
        fun of(store: KeyStore): KeySource = object : KeySource {
            override suspend fun current() = store.current()

            override suspend fun versions() = store.versions()

            override suspend fun clipboardKey(version: Int): ByteArray {
                val adk = store.adk(version)
                try {
                    return Adk.subkey(adk, Adk.CLIPBOARD)
                } finally {
                    adk.fill(0)
                }
            }
        }
    }
}

/** A timeline row. [text] is null when this device cannot decrypt it (a key version it does not hold). */
data class ClipItem(
    val id: String,
    /** Null while the event waits in the offline queue. */
    val seq: Long?,
    val origin: String,
    val createdAt: Long,
    val expiresAt: Long?,
    val size: Int,
    val keyVersion: Int,
    val text: String?,
    val pending: Boolean,
    /** Arrived from another device while the app was open, and not copied yet ("New"). */
    val incoming: Boolean
)

/** A capture skipped as possibly sensitive (automatic capture only). Never stored or sent. */
data class SkippedNotice(val id: String, val at: Long, val kind: SensitiveKind)

/** Why the queue is not empty or an item was lost (the Web's `SendError`). */
enum class SendError { OFFLINE, KEY, RATE_LIMITED, ERROR, REJECTED }

enum class LoadError { OFFLINE, ERROR }

data class ClipboardSnapshot(
    val loaded: Boolean = false,
    /** A refresh from the server succeeded since the engine started (an empty timeline is then really empty). */
    val synced: Boolean = false,
    val loadError: LoadError? = null,
    val syncing: Boolean = false,
    val items: List<ClipItem> = emptyList(),
    val skipped: List<SkippedNotice> = emptyList(),
    val settings: ClipboardSettings? = null,
    val settingsError: Boolean = false,
    val queued: Int = 0,
    val sendError: SendError? = null,
    val unreadable: Int = 0
)

enum class CaptureSource { MANUAL, AUTO }

/** Why a capture stayed in the queue, for the toast. */
enum class QueueReason { OFFLINE, BUSY, RATE_LIMITED, KEY, PAUSED, PENDING }

sealed interface CaptureResult {
    data class Synced(val id: String) : CaptureResult

    data class Queued(val id: String, val reason: QueueReason) : CaptureResult

    data class Removed(val id: String) : CaptureResult

    data class Sensitive(val kind: SensitiveKind) : CaptureResult

    data object Duplicate : CaptureResult

    data object Empty : CaptureResult

    data object TooLarge : CaptureResult

    data object Paused : CaptureResult

    data object NotReady : CaptureResult
}

private enum class Outcome { SYNCED, REMOVED, REJECTED }

private enum class SendOutcome { OK, RESYNC, REJECTED, STOP, HALT }

private enum class DeleteOutcome { OK, STOP, LATER, HALT }

/**
 * Clipboard Sync for one account on this device (docs/CLIPBOARD_PROTOCOL.md §2, PRD §7.4–§7.6): the Android port of
 * `web/src/features/clipboard/engine.ts` with the same protocol rules, minus the Web's coordination between browser tabs
 * (one process here). Holds the decrypted timeline in memory only; the encrypted cache, the offline queue, the pending
 * deletes and the `seq` cursor live in [ClipboardStore].
 *
 * Every state change runs on one confined dispatcher (as the Web's single thread), so no field needs a lock.
 */
class ClipboardEngine(
    private val api: ClipboardEndpoints,
    private val keys: KeySource,
    private val store: ClipboardStore,
    val userId: String,
    val deviceId: String,
    private val onKeyConflict: (suspend () -> Unit)? = null,
    private val now: () -> Long = System::currentTimeMillis,
    private val uuid: () -> String = Items::newItemId,
    dispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1)
) {
    private val confined = dispatcher
    private val scope = CoroutineScope(SupervisorJob() + confined)
    private val _state = MutableStateFlow(ClipboardSnapshot())
    val state: StateFlow<ClipboardSnapshot> = _state.asStateFlow()

    private var events = LinkedHashMap<String, ClipboardEvent>()
    private val queued = LinkedHashMap<String, QueuedEvent>()
    private val texts = HashMap<String, String?>()
    private val incoming = HashSet<String>()
    private var skipped = listOf<SkippedNotice>()
    private var settings: ClipboardSettings? = null
    private var settingsError = false
    private var loaded = false
    private var synced = false
    private var loadError: LoadError? = null
    private var sendError: SendError? = null
    private var refreshing: Deferred<Unit>? = null
    private var refreshAgain = false
    private var flushing: Deferred<Unit>? = null
    private var flushAgain = false

    /** Events seen as tombstones: a late acknowledgement for one never brings its row back. */
    private val tombstoned = HashSet<String>()

    /** Queued events that may already have reached the server (sent before, or queued by an earlier run). */
    private val attempted = HashSet<String>()

    /** Events deleted on this device: only these get a `DELETE` again when they show up live. */
    private val deletedHere = HashSet<String>()
    private val pendingDeletes = LinkedHashMap<String, PendingDelete>()

    /** Captures whose `capture()` call waits for its result, with how each left the queue (null: still queued). */
    private val outcomes = HashMap<String, Outcome?>()
    private var clearing = false
    private var cursor: Long? = null
    private var syncedAt: Long? = null
    private var retryJob: Job? = null
    private var retryAt = 0L
    private var refreshJob: Job? = null
    private var retryDelay = RETRY_MIN_MS
    private var lastText: String? = null
    private var lastSkipped: String? = null
    private var stopped = false
    private var generation: Long? = null
    private var wiped = false

    private suspend fun <T> confined(block: suspend () -> T): T = withContext(confined) { block() }

    private fun emit() {
        if (stopped) return
        _state.value = build()
    }

    private fun build(): ClipboardSnapshot {
        val t = now()
        val items = ArrayList<ClipItem>()
        for (q in queued.values) {
            if (events.containsKey(q.eventId)) continue
            items += ClipItem(q.eventId, null, deviceId, q.queuedAt, null, q.payloadSize, q.keyVersion, texts[q.eventId], true, false)
        }
        events.values
            .filter { e -> parseTime(e.expiresAt)?.let { it > t } ?: true }
            .sortedByDescending { it.seq }
            .take(ClipboardApi.MAX_EVENTS)
            .forEach { e ->
                items += ClipItem(
                    e.eventId,
                    e.seq,
                    e.originDeviceId,
                    parseTime(e.createdAt) ?: t,
                    parseTime(e.expiresAt),
                    e.payloadSize,
                    e.keyVersion,
                    texts[e.eventId],
                    false,
                    e.eventId in incoming
                )
            }
        items.sortWith(compareBy<ClipItem> { !it.pending }.thenByDescending { it.createdAt })
        return ClipboardSnapshot(
            loaded = loaded,
            synced = synced,
            loadError = loadError,
            syncing = refreshing != null,
            items = items,
            skipped = skipped,
            settings = settings,
            settingsError = settingsError,
            queued = queued.size,
            sendError = sendError,
            unreadable = items.count { it.text == null }
        )
    }

    /** Writes to the store unless stopped or wiped since start. Storage errors are ignored (the server is the truth). */
    private suspend fun persist(block: suspend (ClipboardDao) -> Unit): Boolean {
        if (stopped || wiped) return false
        val gen = generation ?: return false
        val wrote =
            try {
                store.write(gen, block)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
        if (wrote == false) wiped = true
        return wrote == true
    }

    private fun settle(id: String, outcome: Outcome) {
        if (outcomes.containsKey(id) && outcomes[id] == null) outcomes[id] = outcome
    }

    /** Reads the cache and the queue, then refreshes from the server, loads the settings and sends what is queued. */
    suspend fun start() {
        confined {
            generation = runCatching { store.generation() }.getOrNull()
            try {
                val snap = store.snapshot(userId)
                val deleted = snap.deletes.map { it.eventId }.toSet()
                for (q in snap.queue) {
                    if (q.eventId in deleted) continue
                    queued[q.eventId] = q
                    attempted += q.eventId
                }
                adopt(snap)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The cache is a convenience: the server refresh below fills the timeline.
            }
            loaded = true
            emit()
        }
        val r = scope.async { refresh() }
        val s = scope.async { loadSettings() }
        r.await()
        s.await()
        scope.launch { flush() }
    }

    private suspend fun adopt(snap: StoreSnapshot) {
        for (d in snap.deletes) {
            pendingDeletes.putIfAbsent(d.eventId, d)
            deletedHere += d.eventId
        }
        val next = LinkedHashMap<String, ClipboardEvent>()
        for (e in snap.events) if (e.isLive && e.eventId !in deletedHere) next[e.eventId] = e
        events = next
        cursor = snap.sync?.cursor
        syncedAt = snap.sync?.syncedAt
        for (id in queued.keys.filter { events.containsKey(it) }) acked(id)
        decryptMissing()
    }

    fun stop() {
        stopped = true
        scope.cancel()
    }

    private suspend fun decrypt(id: String, keyVersion: Int, nonce: String, ciphertext: String): String? = try {
        if (keyVersion !in keys.versions()) {
            null
        } else {
            val key = keys.clipboardKey(keyVersion)
            try {
                Items.decrypt(key, id, keyVersion, EncryptedItem(B64u.decode(nonce), B64u.decode(ciphertext))).toString(Charsets.UTF_8)
            } finally {
                key.fill(0)
            }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    private suspend fun decryptMissing(retryLocked: Boolean = false) {
        for (e in events.values.toList()) {
            val nonce = e.nonce ?: continue
            val ct = e.ciphertext ?: continue
            if (texts.containsKey(e.eventId) && !(retryLocked && texts[e.eventId] == null)) continue
            texts[e.eventId] = decrypt(e.eventId, e.keyVersion, nonce, ct)
        }
        for (q in queued.values.toList()) {
            if (texts.containsKey(q.eventId) && !(retryLocked && texts[q.eventId] == null)) continue
            texts[q.eventId] = decrypt(q.eventId, q.keyVersion, q.nonce, q.ciphertext)
        }
    }

    /** A key check stored new versions: locked rows are tried again, and the queue is sent. */
    suspend fun keysChanged() {
        confined {
            decryptMissing(true)
            if (sendError == SendError.KEY) sendError = null
            emit()
        }
        scope.launch { flush() }
    }

    /**
     * Follows the account's cursor until no newer event is left; the first time (or after a stale cursor) it loads the
     * live timeline. Concurrent calls coalesce into one more pass.
     */
    suspend fun refresh() {
        val run =
            confined {
                refreshing?.let {
                    refreshAgain = true
                    return@confined it
                }
                val d =
                    scope.async {
                        try {
                            do {
                                refreshAgain = false
                                pull()
                            } while (refreshAgain && !stopped)
                        } finally {
                            refreshing = null
                            emit()
                        }
                    }
                refreshing = d
                emit()
                d
            }
        run.await()
    }

    private suspend fun pull() {
        try {
            var from: Long? = cursor
            // Tombstones are kept 7 days (§2.5): an older cursor may have missed deletions, so reload the live timeline.
            val at = syncedAt
            if (from != null && (at == null || now() - at > STALE_CURSOR_MS)) from = null
            if (from == null) {
                val h = api.history()
                val all = h.events.filter { it.isLive }
                val live = all.filter { it.eventId !in deletedHere }
                val t = now()
                persist { it.replace(userId, live.map { e -> CachedEvent.of(userId, e) }, h.cursor, t) }
                events = LinkedHashMap(live.associateBy { it.eventId })
                cursor = h.cursor
                syncedAt = t
                if (live.size < all.size) deleteAgain(all.filter { it.eventId in deletedHere }.map { it.eventId })
                for (id in queued.keys.filter { events.containsKey(it) }) acked(id)
            }
            var page = 0
            while (page < MAX_PAGES && !stopped) {
                page++
                val start = cursor ?: break
                val res = api.events(start)
                val put = ArrayList<ClipboardEvent>()
                val remove = ArrayList<String>()
                val again = ArrayList<String>()
                for (e in res.events) {
                    if (!e.isLive) {
                        remove += e.eventId
                        events.remove(e.eventId)
                        incoming.remove(e.eventId)
                        tombstoned += e.eventId
                        // Deleted elsewhere while still queued here (its create landed, the answer was lost): dropped.
                        if (queued.containsKey(e.eventId)) dropQueued(e.eventId, Outcome.SYNCED)
                        // A tombstone confirms a pending delete.
                        if (pendingDeletes.containsKey(e.eventId)) forgetDelete(e.eventId)
                        texts.remove(e.eventId)
                        continue
                    }
                    if (e.eventId in deletedHere) {
                        remove += e.eventId
                        again += e.eventId
                        continue
                    }
                    put += e
                    val fresh = !events.containsKey(e.eventId) && !queued.containsKey(e.eventId)
                    events[e.eventId] = e
                    if (fresh && loaded && e.originDeviceId != deviceId) incoming += e.eventId
                    if (queued.containsKey(e.eventId)) acked(e.eventId)
                }
                val next = maxOf(start, res.nextCursor, res.events.maxOfOrNull { it.seq } ?: start)
                val t = now()
                val wrote = persist { it.advance(userId, put.map { e -> CachedEvent.of(userId, e) }, remove, next, t) }
                if (again.isNotEmpty()) deleteAgain(again)
                cursor = next
                if (wrote) syncedAt = t
                if (res.events.isEmpty() || next <= start) break
            }
            decryptMissing()
            loadError = null
            synced = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            if (e.status == 429) {
                scheduleRefresh((e.retryAfterSeconds ?: 5) * 1000L)
                return
            }
            loadError = LoadError.ERROR
        } catch (e: NetworkException) {
            loadError = LoadError.OFFLINE
        } catch (e: Exception) {
            loadError = LoadError.ERROR
        }
    }

    private fun scheduleRefresh(ms: Long) {
        if (stopped || refreshJob?.isActive == true) return
        refreshJob =
            scope.launch {
                delay(ms.coerceIn(1000, RETRY_MAX_MS))
                refreshJob = null
                refresh()
            }
    }

    private suspend fun acked(id: String) {
        settle(id, Outcome.SYNCED)
        queued.remove(id)
        attempted.remove(id)
        persist { it.dequeue(userId, id) }
    }

    private suspend fun dropQueued(id: String, outcome: Outcome) {
        settle(id, outcome)
        queued.remove(id)
        attempted.remove(id)
        persist { it.dequeue(userId, id) }
    }

    private suspend fun markDeleted(ids: List<String>, due: Long) {
        if (ids.isEmpty()) return
        val t = now()
        val items = ids.map { PendingDelete(userId, it, pendingDeletes[it]?.at ?: t, due) }
        for (d in items) {
            val id = d.eventId
            settle(id, Outcome.REMOVED)
            pendingDeletes[id] = d
            deletedHere += id
            queued.remove(id)
            attempted.remove(id)
            events.remove(id)
            texts.remove(id)
            incoming.remove(id)
        }
        persist { it.markDeleted(userId, items) }
    }

    private suspend fun deleteAgain(ids: List<String>) {
        markDeleted(ids, now())
        scope.launch { flush() }
    }

    private suspend fun forgetDelete(id: String) {
        pendingDeletes.remove(id)
        persist { it.forgetDelete(userId, id) }
    }

    suspend fun loadSettings() {
        val loadedSettings =
            try {
                api.settings()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
        confined {
            if (loadedSettings != null) {
                settings = loadedSettings
                settingsError = false
            } else {
                settingsError = true
            }
            emit()
        }
    }

    /** `CLIPBOARD_SETTINGS_UPDATED` from another device (metadata only). */
    suspend fun applySettings(s: ClipboardSettings) {
        val resumed =
            confined {
                val r = settings?.paused == true && !s.paused
                settings = s
                settingsError = false
                emit()
                r
            }
        if (resumed) scope.launch { flush() }
    }

    suspend fun saveSettings(next: ClipboardSettings): ClipboardSettings {
        val stored = api.saveSettings(next)
        applySettings(stored)
        return stored
    }

    /** The newest text seen on the clipboard (captured, or written by Copy): repeats are not synced. */
    suspend fun noteClipboardText(text: String) = confined { lastText = text }

    private fun isDuplicate(text: String, source: CaptureSource): Boolean {
        val newest = _state.value.items.firstOrNull { it.text != null }
        if (newest?.text == text) return true
        return source != CaptureSource.MANUAL && (text == lastText || text == lastSkipped)
    }

    /**
     * Encrypts and sends one capture. Manual Sync passes [force] after "Sync anyway" on a capture skipped as possibly
     * sensitive. Automatic captures that look sensitive, or that the source app [flagged], are skipped and noted (never
     * stored).
     */
    suspend fun capture(text: String, source: CaptureSource, force: Boolean = false, flagged: Boolean = false): CaptureResult {
        val id =
            confined {
                if (stopped) return@confined CaptureResult.NotReady
                if (text.isBlank()) return@confined CaptureResult.Empty
                if (settings?.paused == true) return@confined CaptureResult.Paused
                if (text.toByteArray(Charsets.UTF_8).size > ClipboardApi.MAX_PAYLOAD_BYTES) return@confined CaptureResult.TooLarge
                if (isDuplicate(text, source)) return@confined CaptureResult.Duplicate
                val skipSensitive = settings?.sensitiveSkip ?: true
                // A clip the source app flagged sensitive is never captured automatically, whatever the setting says.
                val sensitive =
                    when {
                        force -> null
                        flagged -> SensitiveKind.FLAGGED
                        skipSensitive -> Sensitive.kind(text)
                        else -> null
                    }
                if (sensitive != null) {
                    if (source != CaptureSource.MANUAL) {
                        lastSkipped = text
                        skipped = (listOf(SkippedNotice(uuid(), now(), sensitive)) + skipped).take(20)
                        emit()
                    }
                    return@confined CaptureResult.Sensitive(sensitive)
                }
                val version = keys.current()
                if (version <= 0) return@confined CaptureResult.NotReady
                val id = uuid().lowercase()
                val key = keys.clipboardKey(version)
                val bytes = text.toByteArray(Charsets.UTF_8)
                val enc =
                    try {
                        Items.encrypt(key, id, version, bytes)
                    } finally {
                        key.fill(0)
                    }
                val item = QueuedEvent(userId, id, version, B64u.encode(enc.nonce), B64u.encode(enc.ciphertext), bytes.size, now())
                lastText = text
                texts[id] = text
                queued[id] = item
                outcomes[id] = null
                persist { it.enqueue(item) }
                emit()
                id
            }
        if (id !is String) return id as CaptureResult
        try {
            flush()
            return confined {
                if (queued.containsKey(id)) return@confined CaptureResult.Queued(id, queueReason())
                when (outcomes[id]) {
                    Outcome.SYNCED -> CaptureResult.Synced(id)
                    Outcome.REMOVED -> CaptureResult.Removed(id)
                    Outcome.REJECTED -> CaptureResult.TooLarge
                    null -> CaptureResult.NotReady
                }
            }
        } finally {
            confined { outcomes.remove(id) }
        }
    }

    private fun queueReason(): QueueReason = if (settings?.paused == true) {
        QueueReason.PAUSED
    } else {
        when (sendError) {
            SendError.OFFLINE -> QueueReason.OFFLINE
            SendError.RATE_LIMITED -> QueueReason.RATE_LIMITED
            SendError.ERROR -> QueueReason.BUSY
            SendError.KEY -> QueueReason.KEY
            else -> QueueReason.PENDING
        }
    }

    /** Sends queued events in capture order (idempotent by `event_id`). A call during a pass causes one more pass. */
    suspend fun flush() {
        val run =
            confined {
                flushing?.let {
                    flushAgain = true
                    return@confined it
                }
                val d =
                    scope.async {
                        try {
                            var resync = false
                            do {
                                flushAgain = false
                                if (sendAll()) resync = true
                            } while (flushAgain && !stopped)
                            if (resync && !stopped) scope.launch { refresh() }
                        } finally {
                            flushing = null
                            emit()
                        }
                    }
                flushing = d
                d
            }
        run.await()
    }

    private fun armTimer(ms: Long) {
        if (stopped) return
        val at = now() + ms
        if (retryJob?.isActive == true) {
            if (retryAt <= at) return
            retryJob?.cancel()
        }
        retryAt = at
        retryJob =
            scope.launch {
                delay(ms)
                retryJob = null
                flush()
            }
    }

    private fun scheduleRetry() {
        if (queued.isEmpty() && pendingDeletes.isEmpty()) return
        val d = retryDelay
        if (retryJob?.isActive == true && retryAt <= now() + d) return
        retryDelay = minOf(RETRY_MAX_MS, retryDelay * 2)
        armTimer(d)
    }

    private fun scheduleDue() {
        val next = pendingDeletes.values.minOfOrNull { it.due } ?: return
        armTimer(maxOf(1000L, next - now()))
    }

    private data class DeleteResult(val outcome: DeleteOutcome, val sent: Boolean, val tried: Boolean)

    private suspend fun sendDeletes(): DeleteResult {
        var sent = false
        var tried = false
        for (d in pendingDeletes.values.sortedBy { it.at }) {
            if (stopped) return DeleteResult(DeleteOutcome.HALT, sent, tried)
            val id = d.eventId
            val current = pendingDeletes[id] ?: continue
            if (current.due > now()) continue
            tried = true
            try {
                api.remove(id)
                forgetDelete(id)
                sent = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: NetworkException) {
                sendError = SendError.OFFLINE
                return DeleteResult(DeleteOutcome.STOP, sent, tried)
            } catch (e: ApiException) {
                when {
                    e.status == 404 -> {
                        // Not on the server (yet): a create in flight may land later, so one last DELETE follows the grace.
                        val settleAt = current.at + DELETE_GRACE_MS
                        if (now() >= settleAt) forgetDelete(id) else markDeleted(listOf(id), settleAt)
                    }
                    e.status == 401 || e.status == 403 -> return DeleteResult(DeleteOutcome.HALT, sent, tried)
                    e.status == 400 -> forgetDelete(id)
                    else -> {
                        if (e.status == 429) retryDelay = maxOf(retryDelay, (e.retryAfterSeconds ?: 5) * 1000L)
                        return DeleteResult(DeleteOutcome.LATER, sent, tried)
                    }
                }
            } catch (e: Exception) {
                return DeleteResult(DeleteOutcome.LATER, sent, tried)
            }
        }
        return DeleteResult(DeleteOutcome.OK, sent, tried)
    }

    private suspend fun sendAll(): Boolean {
        val del = sendDeletes()
        var resync = del.sent
        when (del.outcome) {
            DeleteOutcome.STOP -> {
                scheduleRetry()
                return resync
            }
            DeleteOutcome.HALT -> return resync
            else -> Unit
        }
        if (settings?.paused == true || clearing) {
            if (del.outcome == DeleteOutcome.LATER) scheduleRetry() else scheduleDue()
            return resync
        }
        val pending = queued.values.sortedBy { it.queuedAt }
        var rejected = false
        for (item in pending) {
            if (stopped || clearing) return resync
            if (!queued.containsKey(item.eventId)) continue
            val retry = item.eventId in attempted
            when (val outcome = sendOne(item)) {
                SendOutcome.STOP -> {
                    scheduleRetry()
                    return resync
                }
                SendOutcome.HALT -> return resync
                else -> {
                    if (outcome == SendOutcome.REJECTED) rejected = true
                    if (outcome == SendOutcome.RESYNC || (outcome == SendOutcome.OK && retry)) resync = true
                }
            }
        }
        if (pending.isNotEmpty() || del.tried) sendError = if (rejected) SendError.REJECTED else null
        if (del.outcome == DeleteOutcome.LATER) {
            scheduleRetry()
            return resync
        }
        retryDelay = RETRY_MIN_MS
        scheduleDue()
        return resync
    }

    private suspend fun sendOne(first: QueuedEvent): SendOutcome {
        var item = first
        var attempt = 0
        while (true) {
            try {
                attempted += item.eventId
                val res =
                    api.create(
                        ClipboardEventRequest(
                            item.eventId,
                            item.keyVersion,
                            item.nonce,
                            item.ciphertext,
                            item.payloadSize,
                            "TEXT",
                            "text/plain"
                        )
                    )
                val id = item.eventId
                val e = ClipboardEvent(
                    id,
                    res.seq,
                    deviceId,
                    "TEXT",
                    "text/plain",
                    item.keyVersion,
                    item.nonce,
                    item.ciphertext,
                    item.payloadSize,
                    res.createdAt,
                    res.expiresAt,
                    false
                )
                if (id in tombstoned) {
                    // Deleted on another device meanwhile: acknowledged, but not a row again.
                    dropQueued(id, Outcome.SYNCED)
                    texts.remove(id)
                    emit()
                    return SendOutcome.OK
                }
                if (id in deletedHere) return ackDeleted(id)
                if (!queued.containsKey(id)) {
                    // A cursor pull already saw it (the server notifies before it answers the create).
                    settle(id, Outcome.SYNCED)
                    attempted.remove(id)
                    return SendOutcome.OK
                }
                settle(id, Outcome.SYNCED)
                val text = texts[id]
                events[id] = e
                queued.remove(id)
                attempted.remove(id)
                texts[id] = text
                persist {
                    it.dequeue(userId, id)
                    it.putEvents(listOf(CachedEvent.of(userId, e)))
                }
                emit()
                // A seq beyond the applied cursor may be a tombstone's, or one may follow it: follow the cursor now.
                val c = cursor
                return if (c == null || e.seq > c) SendOutcome.RESYNC else SendOutcome.OK
            } catch (e: CancellationException) {
                throw e
            } catch (e: NetworkException) {
                sendError = SendError.OFFLINE
                return SendOutcome.STOP
            } catch (e: ApiException) {
                if (e.code == "key_version_conflict" && attempt == 0 && onKeyConflict != null) {
                    // The account rotated its key: pick it up, re-encrypt under the newest version, send once more.
                    try {
                        onKeyConflict.invoke()
                    } catch (c: CancellationException) {
                        throw c
                    } catch (_: Exception) {
                    }
                    val next = reencrypt(item)
                    if (next != null) {
                        item = next
                        attempt++
                        continue
                    }
                }
                when {
                    e.code == "key_version_conflict" -> {
                        sendError = SendError.KEY
                        return SendOutcome.HALT
                    }
                    e.code == "clipboard_paused" -> {
                        settings =
                            (settings ?: ClipboardSettings(paused = true, retentionDays = 7, sensitiveSkip = true)).copy(paused = true)
                        scope.launch { loadSettings() }
                        return SendOutcome.HALT
                    }
                    e.status == 429 -> {
                        sendError = SendError.RATE_LIMITED
                        retryDelay = maxOf(retryDelay, (e.retryAfterSeconds ?: 5) * 1000L)
                        return SendOutcome.STOP
                    }
                    e.status == 413 || e.status == 400 -> {
                        // The server will never take this one: dropped instead of retried forever.
                        dropQueued(item.eventId, Outcome.REJECTED)
                        texts.remove(item.eventId)
                        emit()
                        return SendOutcome.REJECTED
                    }
                    e.status == 401 || e.status == 403 -> return SendOutcome.HALT
                    else -> {
                        sendError = SendError.ERROR
                        return SendOutcome.STOP
                    }
                }
            } catch (e: Exception) {
                sendError = SendError.ERROR
                return SendOutcome.STOP
            }
        }
    }

    private suspend fun ackDeleted(id: String): SendOutcome {
        markDeleted(listOf(id), now())
        flushAgain = true
        emit()
        return SendOutcome.OK
    }

    private suspend fun reencrypt(item: QueuedEvent): QueuedEvent? {
        val version = keys.current()
        if (version <= item.keyVersion) return null
        val text = texts[item.eventId] ?: decrypt(item.eventId, item.keyVersion, item.nonce, item.ciphertext) ?: return null
        val key = keys.clipboardKey(version)
        val enc =
            try {
                Items.encrypt(key, item.eventId, version, text.toByteArray(Charsets.UTF_8))
            } finally {
                key.fill(0)
            }
        val next = item.copy(keyVersion = version, nonce = B64u.encode(enc.nonce), ciphertext = B64u.encode(enc.ciphertext))
        queued[next.eventId] = next
        persist { it.enqueue(next) }
        return next
    }

    /**
     * Deletes one event on every device. A queued one becomes a pending delete at once (it may have reached the server);
     * a synced one is deleted on the server first (an error is thrown and the row stays).
     */
    suspend fun remove(id: String) {
        val wasQueued = confined { queued.containsKey(id) }
        if (wasQueued) {
            confined {
                markDeleted(listOf(id), now())
                emit()
            }
            flush()
            scope.launch { refresh() }
            return
        }
        try {
            api.remove(id)
        } catch (e: ApiException) {
            if (e.status != 404) throw e
        }
        confined {
            deletedHere += id
            events.remove(id)
            texts.remove(id)
            incoming.remove(id)
            persist { it.removeEvents(userId, listOf(id)) }
            emit()
        }
        scope.launch { refresh() }
    }

    /**
     * Clears the account's clipboard history on every device. Captures queued when Clear was pressed are dropped and never
     * sent after it (pending deletes for the grace period); a capture made after it is kept.
     */
    suspend fun clear() {
        val (before, shown) =
            confined {
                clearing = true
                queued.keys.toSet() to events.keys.toMutableSet()
            }
        try {
            while (true) {
                val f = confined { flushing } ?: break
                runCatching { f.await() }
            }
            confined { shown += events.keys }
            api.clear()
        } catch (e: Exception) {
            confined { clearing = false }
            scope.launch { flush() }
            throw e
        }
        confined {
            markDeleted(before.toList(), now() + DELETE_GRACE_MS)
            clearing = false
            for (id in shown) {
                events.remove(id)
                incoming.remove(id)
                texts.remove(id)
            }
            persist { it.removeEvents(userId, shown.toList()) }
            emit()
        }
        scope.launch { refresh() }
        scope.launch { flush() }
    }

    /** The user copied this row: no longer "New", and the clipboard now holds its text (not captured again). */
    suspend fun markCopied(id: String) = confined {
        texts[id]?.let { lastText = it }
        if (incoming.remove(id)) emit()
    }

    suspend fun dismissSkipped(id: String) = confined {
        skipped = skipped.filter { it.id != id }
        emit()
    }

    companion object {
        const val RETRY_MIN_MS = 5_000L
        const val RETRY_MAX_MS = 60_000L

        /** A cursor older than this is not followed: tombstones are swept after 7 days (one day of margin). */
        const val STALE_CURSOR_MS = 6 * 86_400_000L

        /** How long a pending delete of a queued capture is kept after a 404 (§2.9). */
        const val DELETE_GRACE_MS = 120_000L
        private const val MAX_PAGES = 50

        fun parseTime(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    }
}
