package app.shareanywhere.account.sync

import app.shareanywhere.account.crypto.MemoryKeyStore
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.HistoryEntryRequest
import app.shareanywhere.data.api.HistoryPage
import app.shareanywhere.history.Direction
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryFile
import app.shareanywhere.history.HistoryStatus
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class Server : HistoryEndpoints {
    data class Row(val req: HistoryEntryRequest, val seq: Long, val origin: String, val deleted: Boolean = false)

    val rows = ArrayList<Row>()
    var seq = 0L
    var keyVersion = 1
    var origin = "dev-a"

    override suspend fun historyEntries(after: Long): HistoryPage {
        val page = rows.filter { it.seq > after }.sortedBy { it.seq }
        return HistoryPage(
            page.map {
                app.shareanywhere.data.api.HistoryEntry(
                    it.req.entryId,
                    it.seq,
                    it.req.keyVersion,
                    if (it.deleted) null else it.req.nonce,
                    if (it.deleted) null else it.req.ciphertext,
                    it.origin,
                    "2026-11-11T00:00:00Z",
                    it.deleted
                )
            },
            page.lastOrNull()?.seq ?: after
        )
    }

    override suspend fun addHistoryEntry(req: HistoryEntryRequest): Long {
        if (req.keyVersion != keyVersion) throw ApiException(409, "key_version_conflict", "")
        rows.firstOrNull { it.req.entryId == req.entryId }?.let { return it.seq }
        rows += Row(req, ++seq, origin)
        return seq
    }

    override suspend fun deleteHistoryEntry(id: String) {
        val r = rows.indexOfFirst { it.req.entryId == id && !it.deleted }
        if (r < 0) throw ApiException(404, "not_found", "")
        rows += rows[r].copy(seq = ++seq, deleted = true)
        rows.removeAt(r)
    }

    override suspend fun clearHistory() {
        val live = rows.filter { !it.deleted }
        rows.removeAll { !it.deleted }
        live.forEach { rows += it.copy(seq = ++seq, deleted = true) }
    }
}

private class Local : LocalHistory {
    val entries = LinkedHashMap<String, HistoryEntry>()

    override suspend fun list() = entries.values.toList()

    override suspend fun add(entry: HistoryEntry): Boolean {
        entries[entry.id] = entry
        return true
    }

    override suspend fun remove(id: String) {
        entries.remove(id)
    }
}

private class Meta : HistoryMetaStore {
    var m: HistoryMeta? = null

    override suspend fun get(userId: String) = m?.takeIf { it.userId == userId } ?: HistoryMeta(userId, pushSince = 1_000)

    override suspend fun put(meta: HistoryMeta) {
        m = meta
    }

    override suspend fun wipe() {
        m = null
    }
}

/** Android's port of `historySync.ts` (the Web's rules and payload; entries move between the two clients). */
class HistorySyncTest {
    private fun entry(id: String, at: Long) = HistoryEntry(
        id = id,
        direction = Direction.SENT,
        title = "report.pdf",
        fileCount = 1,
        totalBytes = 2048,
        peer = "Chrome on Windows",
        status = HistoryStatus.COMPLETED,
        createdAt = at,
        files = listOf(HistoryFile("report.pdf", 2048))
    )

    private suspend fun keys(vararg versions: Int) = MemoryKeyStore().also { k ->
        versions.forEach { v -> k.save(v, ByteArray(32) { v.toByte() }) }
    }

    @Test
    fun payloadMatchesTheWebFieldsAndParsesBack() {
        val e = entry("tx:abc", 5_000).copy(transferredBytes = 10, startedAt = 4_000, peers = listOf("a", "b"))
        val json = HistorySync.payloadOf(e)
        assertTrue(json.contains("\"fileCount\":1") && json.contains("\"totalBytes\":2048") && !json.contains("\"id\""))
        val back = HistorySync.parseEntry(json, "sync:x")!!
        assertEquals(e.copy(id = "sync:x"), back)
        assertNull("unknown status is refused", HistorySync.parseEntry(json.replace("completed", "exploded"), "x"))
        assertNull(HistorySync.parseEntry("not json", "x"))
    }

    @Test
    fun entryIdsMatchTheWebDerivation() {
        // SHA-256("tx:abc|dev-a") shaped as a version-8 UUID: deterministic, so a re-upload is idempotent.
        val id = HistorySync.entryUuid("tx:abc", "dev-a")
        // The same value as the Web's entryUuid('tx:abc', 'dev-a') (node: sha256 → v8 UUID).
        assertEquals("624c7b00-106a-8e60-8fcb-e6d48b8178b4", id)
        assertTrue(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(id))
    }

    @Test
    fun uploadsNewEntriesAndPullsOtherDevicesEntries() = runTest {
        val server = Server()
        val local = Local()
        val meta = Meta()
        val k = keys(1)
        local.add(entry("old", 500))
        local.add(entry("new", 2_000))
        val a = HistorySync.Deps(server, k, local, meta, "u", "dev-a", enabled = true)
        val r = HistorySync.sync(a)
        assertEquals("only entries after pushSince without the import", 1, r.pushed)
        // Device B pulls it, shown with the origin device name.
        val localB = Local()
        val metaB = Meta()
        val b = HistorySync.Deps(server, k, localB, metaB, "u", "dev-b", enabled = true, deviceNames = mapOf("dev-a" to "Pixel 7"))
        assertEquals(1, HistorySync.sync(b).pulled)
        val pulled = localB.entries.values.single()
        assertTrue(pulled.id.startsWith(HistorySync.SYNC_PREFIX))
        assertEquals("Pixel 7", pulled.origin)
        // Deleted on A: B's copy goes too.
        HistorySync.deleteSynced(server, meta, "u", listOf("new"))
        HistorySync.sync(b)
        assertTrue(localB.entries.isEmpty())
    }

    @Test
    fun theImportUploadsEveryEntryOnceAndSyncOffPullsNothing() = runTest {
        val server = Server()
        val local = Local()
        val meta = Meta()
        meta.put(HistoryMeta("u", importPending = true, pushSince = 10_000))
        local.add(entry("old", 500))
        val r = HistorySync.sync(HistorySync.Deps(server, keys(1), local, meta, "u", "dev-a", enabled = false))
        assertEquals(1, r.pushed)
        assertFalse(meta.m!!.importPending)
        assertEquals(0, HistorySync.sync(HistorySync.Deps(server, keys(1), local, meta, "u", "dev-a", enabled = false)).pushed)
    }

    @Test
    fun unreadableEntriesArePulledAgainOnceTheKeyArrives() = runTest {
        val server = Server()
        server.keyVersion = 2
        HistorySync.sync(
            HistorySync.Deps(
                server,
                keys(1, 2),
                Local().also {
                    it.add(entry("x", 5_000))
                },
                Meta(),
                "u",
                "dev-a",
                enabled = true
            )
        )
        val local = Local()
        val meta = Meta()
        val r = HistorySync.sync(HistorySync.Deps(server, keys(1), local, meta, "u", "dev-b", enabled = true))
        assertEquals(1, r.unreadable)
        assertTrue(local.entries.isEmpty())
        val again = HistorySync.sync(HistorySync.Deps(server, keys(1, 2), local, meta, "u", "dev-b", enabled = true))
        assertEquals(1, again.pulled)
    }

    @Test
    fun aKeyConflictRunsAKeyCheckAndRetriesOnce() = runTest {
        val server = Server()
        server.keyVersion = 2
        val k = keys(1)
        val r = HistorySync.sync(
            HistorySync.Deps(server, k, Local().also { it.add(entry("x", 5_000)) }, Meta(), "u", "dev-a", enabled = true, onKeyConflict = {
                k.save(2, ByteArray(32) { 2 })
            })
        )
        assertEquals(1, r.pushed)
        assertEquals(2, server.rows.single().req.keyVersion)
    }

    @Test
    fun clearAllWhileOfflineIsSentOnTheNextPass() = runTest {
        val server = Server()
        val local = Local()
        val meta = Meta()
        local.add(entry("x", 5_000))
        HistorySync.sync(HistorySync.Deps(server, keys(1), local, meta, "u", "dev-a", enabled = true))
        val offline =
            object : HistoryEndpoints by server {
                override suspend fun clearHistory() = throw app.shareanywhere.data.api.NetworkException(java.io.IOException("offline"))
            }
        runCatching { HistorySync.clearSynced(offline, meta, "u") }
        assertTrue(meta.m!!.pendingClear)
        HistorySync.sync(HistorySync.Deps(server, keys(1), Local(), meta, "u", "dev-a", enabled = true))
        assertFalse(meta.m!!.pendingClear)
        assertTrue(server.rows.all { it.deleted })
    }
}
