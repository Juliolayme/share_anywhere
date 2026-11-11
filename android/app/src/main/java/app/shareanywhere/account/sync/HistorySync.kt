package app.shareanywhere.account.sync

import android.util.AtomicFile
import app.shareanywhere.account.crypto.Adk
import app.shareanywhere.account.crypto.B64u
import app.shareanywhere.account.crypto.EncryptedItem
import app.shareanywhere.account.crypto.Items
import app.shareanywhere.account.crypto.KeyStore
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.HistoryEntryRequest
import app.shareanywhere.data.api.HistoryPage
import app.shareanywhere.history.Direction
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryFile
import app.shareanywhere.history.HistoryRoute
import app.shareanywhere.history.HistoryStatus
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Per-account history sync bookkeeping (the Web's `AccountSyncMeta`): pull cursor, uploaded entries, deletions waiting for
 * the network, the one-time import, and the unreadable-entry retry point. No keys and no plaintext beyond ids.
 */
@Serializable
data class HistoryMeta(
    val userId: String,
    val cursor: Long = 0,
    val uploaded: Map<String, String> = emptyMap(),
    val pendingDeletes: List<String> = emptyList(),
    val pendingClear: Boolean = false,
    val importPending: Boolean = false,
    val pushSince: Long = 0,
    val retrySeq: Long? = null,
    val retryVersions: List<Int> = emptyList()
)

/** Where [HistoryMeta] lives; erased with the key store when the device leaves the account. */
interface HistoryMetaStore {
    suspend fun get(userId: String): HistoryMeta

    suspend fun put(meta: HistoryMeta)

    suspend fun wipe()
}

class FileHistoryMetaStore(dir: File, private val clock: () -> Long = System::currentTimeMillis) : HistoryMetaStore {
    private val json = Json { ignoreUnknownKeys = true }
    private val file = AtomicFile(File(dir, "history_sync_meta.json"))
    private val lock = Mutex()

    override suspend fun get(userId: String): HistoryMeta = lock.withLock {
        withContext(Dispatchers.IO) {
            runCatching { json.decodeFromString(HistoryMeta.serializer(), file.readFully().toString(Charsets.UTF_8)) }
                .getOrNull()
                ?.takeIf { it.userId == userId }
                ?: HistoryMeta(userId, pushSince = clock())
        }
    }

    override suspend fun put(meta: HistoryMeta) = lock.withLock {
        withContext(Dispatchers.IO) {
            val out = file.startWrite()
            try {
                out.write(json.encodeToString(HistoryMeta.serializer(), meta).toByteArray())
                file.finishWrite(out)
            } catch (e: Exception) {
                file.failWrite(out)
                throw e
            }
        }
    }

    override suspend fun wipe() = lock.withLock { withContext(Dispatchers.IO) { file.delete() } }
}

/** The account endpoints history sync uses. */
interface HistoryEndpoints {
    suspend fun historyEntries(after: Long): HistoryPage

    suspend fun addHistoryEntry(req: HistoryEntryRequest): Long

    suspend fun deleteHistoryEntry(id: String)

    suspend fun clearHistory()
}

/** The local History operations sync needs. */
interface LocalHistory {
    suspend fun list(): List<HistoryEntry>

    suspend fun add(entry: HistoryEntry): Boolean

    suspend fun remove(id: String)
}

data class SyncResult(val pushed: Int = 0, val pulled: Int = 0, val removed: Int = 0, val unreadable: Int = 0)

/**
 * Encrypted cloud history sync (PRD §2 "History", §7.5; docs/API.md §2.4), the Android port of
 * `web/src/features/account/sync/historySync.ts`: the same entry ids, JSON payload and rules, so entries move between
 * the Web and Android.
 */
object HistorySync {
    /** Local id of an entry pulled from the account. */
    const val SYNC_PREFIX = "sync:"

    fun syncedId(entryId: String) = "$SYNC_PREFIX$entryId"

    /** Server `entry_id` for a local entry: SHA-256 of `<local id>|<device id>`, shaped as a version-8 UUID. */
    fun entryUuid(localId: String, deviceId: String): String =
        Items.itemIdFromBytes(MessageDigest.getInstance("SHA-256").digest("$localId|$deviceId".toByteArray()))

    /** What is uploaded: the entry without local-only fields, with the Web's field names. */
    fun payloadOf(e: HistoryEntry): String = buildJsonObject {
        put("direction", e.direction.wire)
        put("title", e.title)
        put("fileCount", e.fileCount)
        put("totalBytes", e.totalBytes)
        e.transferredBytes?.let { put("transferredBytes", it) }
        put("peer", e.peer)
        put("status", e.status.wire)
        put("createdAt", e.createdAt)
        e.peers?.let { p -> put("peers", buildJsonArray { p.forEach { add(JsonPrimitive(it)) } }) }
        e.files?.let { files ->
            put(
                "files",
                buildJsonArray {
                    files.forEach { f ->
                        add(
                            buildJsonObject {
                                put("name", f.name)
                                put("size", f.size)
                                f.transferredBytes?.let { put("transferredBytes", it) }
                            }
                        )
                    }
                }
            )
        }
        e.route?.let { put("route", it.wire) }
        e.startedAt?.let { put("startedAt", it) }
    }.toString()

    private fun JsonObject.str(k: String, max: Int = 1024): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf {
        it.length <=
            max
    }

    private fun JsonObject.num(k: String): Long? = (this[k] as? JsonPrimitive)
        ?.takeIf { !it.isString }
        ?.doubleOrNull
        ?.takeIf { it.isFinite() && it >= 0 && it <= Long.MAX_VALUE.toDouble() }
        ?.toLong()

    /** Validates a decrypted entry: only known fields with sane types reach History. */
    fun parseEntry(text: String, id: String): HistoryEntry? {
        val raw = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
        val direction = Direction.entries.firstOrNull { it.wire == raw.str("direction") } ?: return null
        val status = HistoryStatus.entries.firstOrNull { it.wire == raw.str("status") } ?: return null
        val title = raw.str("title") ?: return null
        val peer = raw.str("peer") ?: return null
        val fileCount = raw.num("fileCount") ?: return null
        val totalBytes = raw.num("totalBytes") ?: return null
        val createdAt = raw.num("createdAt") ?: return null
        val peers = (raw["peers"] as? JsonArray)?.takeIf { a ->
            a.size <= 5 &&
                a.all { (it as? JsonPrimitive)?.isString == true && it.content.length <= 120 }
        }
            ?.map { (it as JsonPrimitive).content }
        val files = (raw["files"] as? JsonArray)?.takeIf { it.size <= 1000 }?.mapNotNull { f ->
            val o = f as? JsonObject ?: return@mapNotNull null
            val name = o.str("name") ?: return@mapNotNull null
            val size = o.num("size") ?: return@mapNotNull null
            HistoryFile(name, size, o.num("transferredBytes"))
        }
        return HistoryEntry(
            id = id,
            direction = direction,
            title = title,
            fileCount = fileCount.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
            totalBytes = totalBytes,
            transferredBytes = raw.num("transferredBytes"),
            peer = peer,
            status = status,
            createdAt = createdAt,
            peers = peers,
            files = files,
            route = HistoryRoute.entries.firstOrNull { it.wire == raw.str("route") },
            startedAt = raw.num("startedAt")
        )
    }

    class Deps(
        val api: HistoryEndpoints,
        val keys: KeyStore,
        val history: LocalHistory,
        val meta: HistoryMetaStore,
        val userId: String,
        val deviceId: String,
        /** Account-wide `history_sync`. Off: only a pending import uploads, nothing is pulled. */
        val enabled: Boolean,
        val deviceNames: Map<String, String> = emptyMap(),
        /** Runs a key check after `409 key_version_conflict`; the upload is retried once. */
        val onKeyConflict: (suspend () -> Unit)? = null
    )

    private suspend fun flushDeletes(api: HistoryEndpoints, m: HistoryMeta, save: suspend (HistoryMeta) -> Unit): HistoryMeta {
        var meta = m
        if (meta.pendingClear) {
            api.clearHistory()
            meta = meta.copy(pendingClear = false, pendingDeletes = emptyList())
            save(meta)
        }
        while (meta.pendingDeletes.isNotEmpty()) {
            val id = meta.pendingDeletes.first()
            try {
                api.deleteHistoryEntry(id)
            } catch (e: ApiException) {
                if (e.status != 404) throw e
            }
            meta = meta.copy(pendingDeletes = meta.pendingDeletes.drop(1))
            save(meta)
        }
        return meta
    }

    private suspend fun subkey(keys: KeyStore, v: Int): ByteArray {
        val adk = keys.adk(v)
        try {
            return Adk.subkey(adk, Adk.HISTORY)
        } finally {
            adk.fill(0)
        }
    }

    private suspend fun pushOnce(d: Deps, holder: Array<HistoryMeta>, count: IntArray) {
        val v = d.keys.current()
        if (v == 0) return
        val key = subkey(d.keys, v)
        try {
            for (entry in d.history.list()) {
                val meta = holder[0]
                if (entry.id.startsWith(SYNC_PREFIX) || meta.uploaded.containsKey(entry.id)) continue
                if (!meta.importPending && entry.createdAt < meta.pushSince) continue
                val entryId = entryUuid(entry.id, d.deviceId)
                val item = Items.encrypt(key, entryId, v, payloadOf(entry).toByteArray())
                d.api.addHistoryEntry(HistoryEntryRequest(entryId, v, B64u.encode(item.nonce), B64u.encode(item.ciphertext)))
                holder[0] = holder[0].copy(uploaded = holder[0].uploaded + (entry.id to entryId))
                count[0]++
            }
            holder[0] = holder[0].copy(importPending = false)
        } finally {
            key.fill(0)
        }
    }

    private suspend fun push(d: Deps, holder: Array<HistoryMeta>): Int {
        if (!d.enabled && !holder[0].importPending) return 0
        val count = intArrayOf(0)
        var attempt = 0
        while (true) {
            try {
                pushOnce(d, holder, count)
                return count[0]
            } catch (e: ApiException) {
                val conflict = e.code == "key_version_conflict"
                if (!conflict || attempt > 0 || d.onKeyConflict == null) throw e
                attempt++
                d.onKeyConflict.invoke()
            }
        }
    }

    /** Entries skipped as unreadable are pulled again once the device holds a key version it lacked then. */
    fun rewindForNewKeys(meta: HistoryMeta, held: List<Int>): HistoryMeta {
        val seq = meta.retrySeq ?: return meta
        if (held.none { it !in meta.retryVersions }) return meta
        return meta.copy(cursor = minOf(meta.cursor, maxOf(0, seq - 1)), retrySeq = null, retryVersions = emptyList())
    }

    private suspend fun pull(d: Deps, holder: Array<HistoryMeta>): IntArray {
        val out = intArrayOf(0, 0, 0) // pulled, removed, unreadable
        if (!d.enabled) return out
        val held = d.keys.versions()
        holder[0] = rewindForNewKeys(holder[0], held)
        fun skipped(seq: Long) {
            out[2]++
            val m = holder[0]
            holder[0] = m.copy(retrySeq = m.retrySeq?.let { minOf(it, seq) } ?: seq, retryVersions = held)
        }
        for (page in 0 until 50) {
            val res = d.api.historyEntries(holder[0].cursor)
            if (res.entries.isEmpty()) return out
            val mine = holder[0].uploaded.entries.associate { (local, remote) -> remote to local }
            for (e in res.entries) {
                val local = mine[e.entryId]
                if (e.deleted) {
                    if (local != null) {
                        d.history.remove(local)
                        holder[0] = holder[0].copy(uploaded = holder[0].uploaded - local)
                        out[1]++
                    }
                    d.history.remove(syncedId(e.entryId))
                    continue
                }
                val nonce = e.nonce
                val ct = e.ciphertext
                if (local != null || e.originDeviceId == d.deviceId || nonce == null || ct == null) continue
                if (!d.keys.has(e.keyVersion)) {
                    skipped(e.seq)
                    continue
                }
                val text =
                    try {
                        val key = subkey(d.keys, e.keyVersion)
                        try {
                            Items.decrypt(
                                key,
                                e.entryId,
                                e.keyVersion,
                                EncryptedItem(B64u.decode(nonce), B64u.decode(ct))
                            ).toString(Charsets.UTF_8)
                        } finally {
                            key.fill(0)
                        }
                    } catch (c: CancellationException) {
                        throw c
                    } catch (_: Exception) {
                        null
                    }
                val parsed = text?.let { parseEntry(it, syncedId(e.entryId)) }
                if (parsed == null) {
                    skipped(e.seq)
                    continue
                }
                d.history.add(parsed.copy(origin = d.deviceNames[e.originDeviceId]))
                out[0]++
            }
            holder[0] = holder[0].copy(cursor = res.nextAfter)
            d.meta.put(holder[0])
        }
        return out
    }

    /**
     * One pass: deletions made offline, uploads (new entries while sync is on, every one once after "Copy this device's
     * transfer history"), then everything after the cursor. Bookkeeping that succeeded is saved before an error propagates.
     */
    suspend fun sync(d: Deps): SyncResult {
        val holder = arrayOf(d.meta.get(d.userId))
        try {
            holder[0] = flushDeletes(d.api, holder[0]) { holder[0] = it }
            val pushed = push(d, holder)
            val p = pull(d, holder)
            return SyncResult(pushed, p[0], p[1], p[2])
        } finally {
            d.meta.put(holder[0])
        }
    }

    /** A local deletion tombstones the matching server entry (queued when offline). */
    suspend fun deleteSynced(api: HistoryEndpoints, store: HistoryMetaStore, userId: String, localIds: List<String>) {
        var meta = store.get(userId)
        val remote = localIds.mapNotNull { id -> if (id.startsWith(SYNC_PREFIX)) id.removePrefix(SYNC_PREFIX) else meta.uploaded[id] }
        meta = meta.copy(uploaded = meta.uploaded - localIds.toSet(), pendingDeletes = (meta.pendingDeletes + remote).distinct())
        store.put(meta)
        try {
            meta = flushDeletes(api, meta) { meta = it }
        } finally {
            store.put(meta)
        }
    }

    /** "Clear all" while syncing tombstones the whole account history (queued when offline). */
    suspend fun clearSynced(api: HistoryEndpoints, store: HistoryMetaStore, userId: String) {
        var meta = store.get(userId).copy(pendingClear = true, uploaded = emptyMap())
        store.put(meta)
        try {
            meta = flushDeletes(api, meta) { meta = it }
        } finally {
            store.put(meta)
        }
    }
}
