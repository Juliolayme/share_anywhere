package app.shareanywhere.clipboard

import app.shareanywhere.account.crypto.B64u
import app.shareanywhere.account.crypto.EncryptedItem
import app.shareanywhere.account.crypto.Items
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.ClipboardEvent
import app.shareanywhere.data.api.ClipboardEventCreated
import app.shareanywhere.data.api.ClipboardEventPage
import app.shareanywhere.data.api.ClipboardEventRequest
import app.shareanywhere.data.api.ClipboardHistory
import app.shareanywhere.data.api.ClipboardSettings
import app.shareanywhere.data.api.NetworkException
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** An account's clipboard on a fake server (docs/CLIPBOARD_PROTOCOL.md §2): seq cursor, tombstones, idempotent create. */
private class FakeServer(private val clock: () -> Long) : ClipboardEndpoints {
    var seq = 0L
    val log = ArrayList<ClipboardEvent>()
    var settings = ClipboardSettings(paused = false, retentionDays = 7, sensitiveSkip = true)
    var offline = false
    var keyVersion = 1
    val deletes = ArrayList<String>()
    var creates = 0

    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    private fun net() {
        if (offline) throw NetworkException(IOException("offline"))
    }

    fun live() = log.groupBy { it.eventId }.mapValues { it.value.last() }.values.filter { !it.deleted }

    fun addFromOtherDevice(id: String, version: Int, nonce: String, ct: String, size: Int) {
        log +=
            ClipboardEvent(
                id, ++seq, "other-device", "TEXT", "text/plain", version, nonce, ct, size, iso(clock()),
                iso(
                    clock() + 7 * 86_400_000L
                ),
                false
            )
    }

    fun deleteOnServer(id: String) {
        val e = log.last { it.eventId == id }
        log += e.copy(seq = ++seq, nonce = null, ciphertext = null, deleted = true)
    }

    override suspend fun history(limit: Int): ClipboardHistory {
        net()
        return ClipboardHistory(live().sortedByDescending { it.seq }, seq)
    }

    override suspend fun events(cursor: Long, limit: Int): ClipboardEventPage {
        net()
        val page = log.filter { it.seq > cursor }.groupBy { it.eventId }.map { it.value.last() }.sortedBy { it.seq }.take(limit)
        return ClipboardEventPage(page, page.lastOrNull()?.seq ?: cursor)
    }

    override suspend fun create(req: ClipboardEventRequest): ClipboardEventCreated {
        net()
        creates++
        if (settings.paused) throw ApiException(409, "clipboard_paused", "")
        if (req.keyVersion != keyVersion) throw ApiException(409, "key_version_conflict", "")
        val existing = log.lastOrNull { it.eventId == req.eventId }
        if (existing != null) return ClipboardEventCreated(existing.seq, existing.createdAt, existing.expiresAt)
        val e = ClipboardEvent(
            req.eventId,
            ++seq,
            "this-device",
            "TEXT",
            "text/plain",
            req.keyVersion,
            req.nonce,
            req.ciphertext,
            req.payloadSize,
            iso(clock()),
            iso(clock() + 7 * 86_400_000L),
            false
        )
        log += e
        return ClipboardEventCreated(e.seq, e.createdAt, e.expiresAt)
    }

    override suspend fun remove(eventId: String) {
        net()
        deletes += eventId
        if (live().none { it.eventId == eventId }) throw ApiException(404, "not_found", "")
        deleteOnServer(eventId)
    }

    override suspend fun clear() {
        net()
        for (e in live()) deleteOnServer(e.eventId)
    }

    override suspend fun settings(): ClipboardSettings {
        net()
        return settings
    }

    override suspend fun saveSettings(s: ClipboardSettings): ClipboardSettings {
        net()
        settings = s
        return s
    }
}

/** Room's DAO in memory (the @Transaction defaults of the interface still apply). */
private class MemoryDao : ClipboardDao {
    val events = LinkedHashMap<Pair<String, String>, CachedEvent>()
    val queue = LinkedHashMap<Pair<String, String>, QueuedEvent>()
    val deletes = LinkedHashMap<Pair<String, String>, PendingDelete>()
    val sync = HashMap<String, SyncState>()

    override suspend fun events(userId: String) = events.values.filter { it.userId == userId }

    override suspend fun queue(userId: String) = queue.values.filter { it.userId == userId }.sortedBy { it.queuedAt }

    override suspend fun deletes(userId: String) = deletes.values.filter { it.userId == userId }

    override suspend fun sync(userId: String) = sync[userId]

    override suspend fun putEvents(e: List<CachedEvent>) = e.forEach { events[it.userId to it.eventId] = it }

    override suspend fun removeEvents(userId: String, ids: List<String>) = ids.forEach { events.remove(userId to it) }

    override suspend fun clearEvents(userId: String) {
        events.keys.removeAll { it.first == userId }
    }

    override suspend fun enqueue(q: QueuedEvent) {
        queue[q.userId to q.eventId] = q
    }

    override suspend fun dequeue(userId: String, id: String) {
        queue.remove(userId to id)
    }

    override suspend fun putDeletes(d: List<PendingDelete>) = d.forEach { deletes[it.userId to it.eventId] = it }

    override suspend fun forgetDelete(userId: String, id: String) {
        deletes.remove(userId to id)
    }

    override suspend fun putSync(s: SyncState) {
        sync[s.userId] = s
    }

    override suspend fun wipeEvents() = events.clear()

    override suspend fun wipeQueue() = queue.clear()

    override suspend fun wipeDeletes() = deletes.clear()

    override suspend fun wipeSync() = sync.clear()
}

private class Keys(var current: Int = 1) : KeySource {
    val keys = mutableMapOf(1 to ByteArray(32) { 1 }, 2 to ByteArray(32) { 2 })

    override suspend fun current() = current

    override suspend fun versions() = keys.keys.filter { it <= current }.sorted()

    override suspend fun clipboardKey(version: Int) = keys.getValue(version).copyOf()
}

@OptIn(ExperimentalCoroutinesApi::class)
class ClipboardEngineTest {
    private val user = "user-1"
    private val device = "this-device"

    private class Setup(val scope: TestScope) {
        val server = FakeServer { scope.testScheduler.currentTime + 1_700_000_000_000L }
        val dao = MemoryDao()
        val store = ClipboardStore(dao)
        val keys = Keys()
    }

    private fun TestScope.engine(s: Setup, onKeyConflict: (suspend () -> Unit)? = null) = ClipboardEngine(
        s.server,
        s.keys,
        s.store,
        user,
        device,
        onKeyConflict,
        now = { testScheduler.currentTime + 1_700_000_000_000L },
        dispatcher = StandardTestDispatcher(testScheduler)
    )

    private fun encrypt(key: ByteArray, id: String, v: Int, text: String): Pair<String, String> {
        val item = Items.encrypt(key, id, v, text.toByteArray())
        return B64u.encode(item.nonce) to B64u.encode(item.ciphertext)
    }

    @Test
    fun captureEncryptsSendsAndShowsTheRow() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        val r = e.capture("Order #A-5531 ships Thursday", CaptureSource.MANUAL)
        assertTrue(r is CaptureResult.Synced)
        val id = (r as CaptureResult.Synced).id
        assertTrue("lowercase canonical id (the AAD)", Items.isItemId(id))
        val sent = s.server.live().single()
        // The server only ever sees ciphertext; the account key opens it with the id|version AAD.
        assertFalse(String(B64u.decode(sent.ciphertext!!)).contains("Order"))
        val plain = Items.decrypt(ByteArray(32) { 1 }, id, 1, EncryptedItem(B64u.decode(sent.nonce!!), B64u.decode(sent.ciphertext!!)))
        assertEquals("Order #A-5531 ships Thursday", String(plain))
        val row = e.state.value.items.single()
        assertEquals("Order #A-5531 ships Thursday", row.text)
        assertFalse(row.pending)
        assertEquals("cached as ciphertext", 1, s.dao.events.size)
        e.stop()
    }

    @Test
    fun offlineCapturesQueueAndSendOnceWhenBackWithoutDuplicates() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        s.server.offline = true
        val r = e.capture("meeting notes", CaptureSource.MANUAL)
        assertEquals(QueueReason.OFFLINE, (r as CaptureResult.Queued).reason)
        assertEquals(1, e.state.value.queued)
        assertEquals("persisted in the offline queue", 1, s.dao.queue.size)
        assertTrue(e.state.value.items.single().pending)
        s.server.offline = false
        advanceTimeBy(ClipboardEngine.RETRY_MIN_MS + 1)
        advanceUntilIdle()
        assertEquals(0, e.state.value.queued)
        assertEquals(0, s.dao.queue.size)
        assertEquals(1, s.server.live().size)
        // A retry of the same event id is idempotent on the server.
        assertEquals(1, s.server.log.size)
        e.stop()
    }

    @Test
    fun aQueuedCaptureSurvivesARestart() = runTest {
        val s = Setup(this)
        val first = engine(s)
        first.start()
        s.server.offline = true
        first.capture("from the last run", CaptureSource.MANUAL)
        first.stop()
        s.server.offline = false
        val second = engine(s)
        second.start()
        advanceUntilIdle()
        assertEquals("from the last run", second.state.value.items.single().text)
        assertEquals(1, s.server.live().size)
        second.stop()
    }

    @Test
    fun itemsFromOtherDevicesArriveByCursorAndAreNewUntilCopied() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        val id = "0b5c2a8e-7d3f-4e21-9a6b-1c2d3e4f5a6b"
        val (n, c) = encrypt(ByteArray(32) { 1 }, id, 1, "hello from the PC")
        s.server.addFromOtherDevice(id, 1, n, c, 17)
        e.refresh()
        val row = e.state.value.items.single()
        assertEquals("hello from the PC", row.text)
        assertTrue(row.incoming)
        e.markCopied(id)
        assertFalse(e.state.value.items.single().incoming)
        // Deleted on another device: its tombstone removes the row here.
        s.server.deleteOnServer(id)
        e.refresh()
        assertTrue(e.state.value.items.isEmpty())
        assertTrue(s.dao.events.isEmpty())
        e.stop()
    }

    @Test
    fun aRowUnderAKeyThisDeviceLacksIsLockedUntilTheKeyArrives() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        val id = "1b5c2a8e-7d3f-4e21-9a6b-1c2d3e4f5a6b"
        val (n, c) = encrypt(ByteArray(32) { 2 }, id, 2, "newer key")
        s.server.addFromOtherDevice(id, 2, n, c, 9)
        e.refresh()
        assertNull(e.state.value.items.single().text)
        assertEquals(1, e.state.value.unreadable)
        s.keys.current = 2
        e.keysChanged()
        advanceUntilIdle()
        assertEquals("newer key", e.state.value.items.single().text)
        e.stop()
    }

    @Test
    fun sensitiveTextIsSkippedAutomaticallyAndNeedsSyncAnywayManually() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        assertEquals(CaptureResult.Sensitive(SensitiveKind.OTP), e.capture("482913", CaptureSource.AUTO))
        assertEquals(1, e.state.value.skipped.size)
        assertTrue("never stored or sent", s.server.log.isEmpty() && s.dao.queue.isEmpty())
        assertEquals(CaptureResult.Sensitive(SensitiveKind.OTP), e.capture("482913", CaptureSource.MANUAL))
        assertTrue(e.capture("482913", CaptureSource.MANUAL, force = true) is CaptureResult.Synced)
        // A clip the source app flagged is skipped automatically even when the account turned the heuristics off.
        e.applySettings(s.server.settings.copy(sensitiveSkip = false))
        assertEquals(CaptureResult.Sensitive(SensitiveKind.FLAGGED), e.capture("plain words", CaptureSource.AUTO, flagged = true))
        assertTrue(e.capture("Tr0ub4dor&3", CaptureSource.AUTO) is CaptureResult.Synced)
        e.dismissSkipped(e.state.value.skipped.first().id)
        assertEquals(1, e.state.value.skipped.size)
        e.stop()
    }

    @Test
    fun duplicatesEmptyTooLargeAndPausedAreNotSent() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        assertTrue(e.capture("same text", CaptureSource.MANUAL) is CaptureResult.Synced)
        assertEquals(CaptureResult.Duplicate, e.capture("same text", CaptureSource.MANUAL))
        assertEquals(CaptureResult.Empty, e.capture("   ", CaptureSource.MANUAL))
        assertEquals(CaptureResult.TooLarge, e.capture("x".repeat(ClipboardApi.MAX_PAYLOAD_BYTES + 1), CaptureSource.MANUAL))
        e.saveSettings(s.server.settings.copy(paused = true))
        assertEquals(CaptureResult.Paused, e.capture("while paused", CaptureSource.MANUAL))
        assertEquals(1, s.server.creates)
        e.stop()
    }

    @Test
    fun aKeyVersionConflictPicksUpTheRotationAndReencrypts() = runTest {
        val s = Setup(this)
        s.server.keyVersion = 2
        val e = engine(s, onKeyConflict = { s.keys.current = 2 })
        e.start()
        val r = e.capture("after rotation", CaptureSource.MANUAL)
        assertTrue(r is CaptureResult.Synced)
        assertEquals(2, s.server.live().single().keyVersion)
        // Without the rotation the item stays queued and the reason is the key.
        val stuck = Setup(this).also { it.server.keyVersion = 2 }
        val e2 = engine(stuck, onKeyConflict = {})
        e2.start()
        assertEquals(QueueReason.KEY, (e2.capture("stuck", CaptureSource.MANUAL) as CaptureResult.Queued).reason)
        assertEquals(SendError.KEY, e2.state.value.sendError)
        e.stop()
        e2.stop()
    }

    @Test
    fun deletingAQueuedItemOfflineSendsTheDeleteLater() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        s.server.offline = true
        val id = (e.capture("delete me", CaptureSource.MANUAL) as CaptureResult.Queued).id
        e.remove(id)
        assertTrue(e.state.value.items.isEmpty())
        assertEquals(1, s.dao.deletes.size)
        assertTrue(s.dao.queue.isEmpty())
        s.server.offline = false
        advanceTimeBy(ClipboardEngine.RETRY_MIN_MS + 1)
        advanceUntilIdle()
        assertTrue("the DELETE went out", id in s.server.deletes)
        assertTrue("never created", s.server.live().isEmpty())
        // 404 inside the grace period keeps it; after the grace it is settled.
        advanceTimeBy(ClipboardEngine.DELETE_GRACE_MS + 1)
        advanceUntilIdle()
        assertTrue(s.dao.deletes.isEmpty())
        e.stop()
    }

    @Test
    fun clearDeletesEverywhereAndDropsWhatWasQueued() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        e.capture("one", CaptureSource.MANUAL)
        e.capture("two", CaptureSource.MANUAL)
        assertEquals(2, s.server.live().size)
        e.clear()
        advanceUntilIdle()
        assertTrue(s.server.live().isEmpty())
        assertTrue(e.state.value.items.isEmpty())
        assertTrue(s.dao.events.isEmpty())
        e.stop()
    }

    @Test
    fun aWipedStoreIsNeverWrittenAgain() = runTest {
        val s = Setup(this)
        val e = engine(s)
        e.start()
        s.store.wipe()
        s.server.offline = true
        e.capture("after sign-out", CaptureSource.MANUAL)
        assertTrue("nothing of the old account is written", s.dao.queue.isEmpty() && s.dao.events.isEmpty())
        e.stop()
    }

    @Test
    fun aStaleCursorReloadsTheLiveTimeline() = runTest {
        val s = Setup(this)
        val first = engine(s)
        first.start()
        first.capture("kept", CaptureSource.MANUAL)
        first.stop()
        // Seven days later the cached cursor may have missed swept tombstones: the history is loaded again.
        advanceTimeBy(ClipboardEngine.STALE_CURSOR_MS + 1)
        val id = s.server.live().single().eventId
        s.server.deleteOnServer(id)
        s.server.log.removeAll { it.eventId == id }
        val second = engine(s)
        second.start()
        assertTrue(second.state.value.items.isEmpty())
        second.stop()
    }

    @Test
    fun settingsFromTheSocketAreValidated() {
        fun ev(vararg pairs: Pair<String, kotlinx.serialization.json.JsonElement>) =
            app.shareanywhere.data.ws.SocketEvent("CLIPBOARD_SETTINGS_UPDATED", kotlinx.serialization.json.JsonObject(mapOf(*pairs)))
        val ok = ev(
            "paused" to kotlinx.serialization.json.JsonPrimitive(true),
            "retention_days" to kotlinx.serialization.json.JsonPrimitive(3),
            "sensitive_skip" to kotlinx.serialization.json.JsonPrimitive(false)
        )
        assertEquals(ClipboardSettings(true, 3, false), ClipboardRuntime.settingsFrom(ok))
        val bad = ev(
            "paused" to kotlinx.serialization.json.JsonPrimitive(true),
            "retention_days" to kotlinx.serialization.json.JsonPrimitive(30),
            "sensitive_skip" to kotlinx.serialization.json.JsonPrimitive(false)
        )
        assertNull(ClipboardRuntime.settingsFrom(bad))
    }
}
