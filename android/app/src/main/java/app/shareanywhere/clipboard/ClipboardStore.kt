package app.shareanywhere.clipboard

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import app.shareanywhere.data.api.ClipboardEvent
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** A cached live event (ciphertext only: the plaintext is never written to disk). */
@Entity(tableName = "clip_events", primaryKeys = ["user_id", "event_id"])
data class CachedEvent(
    @ColumnInfo(name = "user_id") val userId: String,
    @ColumnInfo(name = "event_id") val eventId: String,
    val seq: Long,
    @ColumnInfo(name = "origin_device_id") val originDeviceId: String,
    @ColumnInfo(name = "key_version") val keyVersion: Int,
    val nonce: String,
    val ciphertext: String,
    @ColumnInfo(name = "payload_size") val payloadSize: Int,
    @ColumnInfo(name = "created_at") val createdAt: String,
    @ColumnInfo(name = "expires_at") val expiresAt: String
) {
    fun toEvent() = ClipboardEvent(
        eventId = eventId,
        seq = seq,
        originDeviceId = originDeviceId,
        eventType = "TEXT",
        mimeType = "text/plain",
        keyVersion = keyVersion,
        nonce = nonce,
        ciphertext = ciphertext,
        payloadSize = payloadSize,
        createdAt = createdAt,
        expiresAt = expiresAt,
        deleted = false
    )

    companion object {
        fun of(userId: String, e: ClipboardEvent) = CachedEvent(
            userId,
            e.eventId,
            e.seq,
            e.originDeviceId,
            e.keyVersion,
            requireNotNull(e.nonce),
            requireNotNull(e.ciphertext),
            e.payloadSize,
            e.createdAt,
            e.expiresAt
        )
    }
}

/** A capture encrypted on this device and waiting for the server (the offline queue, §2.9). */
@Entity(tableName = "clip_queue", primaryKeys = ["user_id", "event_id"])
data class QueuedEvent(
    @ColumnInfo(name = "user_id") val userId: String,
    @ColumnInfo(name = "event_id") val eventId: String,
    @ColumnInfo(name = "key_version") val keyVersion: Int,
    val nonce: String,
    val ciphertext: String,
    @ColumnInfo(name = "payload_size") val payloadSize: Int,
    @ColumnInfo(name = "queued_at") val queuedAt: Long
)

/** A `DELETE` not confirmed yet (§2.9), sent once [due] has come. */
@Entity(tableName = "clip_deletes", primaryKeys = ["user_id", "event_id"])
data class PendingDelete(
    @ColumnInfo(name = "user_id") val userId: String,
    @ColumnInfo(name = "event_id") val eventId: String,
    val at: Long,
    val due: Long
)

/** The account's `seq` cursor this device's cache is applied up to, and when it last caught up. */
@Entity(tableName = "clip_sync", primaryKeys = ["user_id"])
data class SyncState(
    @ColumnInfo(name = "user_id") val userId: String,
    val cursor: Long?,
    @ColumnInfo(name = "synced_at") val syncedAt: Long?
)

@Dao
interface ClipboardDao {
    @Query("SELECT * FROM clip_events WHERE user_id = :userId")
    suspend fun events(userId: String): List<CachedEvent>

    @Query("SELECT * FROM clip_queue WHERE user_id = :userId ORDER BY queued_at")
    suspend fun queue(userId: String): List<QueuedEvent>

    @Query("SELECT * FROM clip_deletes WHERE user_id = :userId")
    suspend fun deletes(userId: String): List<PendingDelete>

    @Query("SELECT * FROM clip_sync WHERE user_id = :userId")
    suspend fun sync(userId: String): SyncState?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putEvents(e: List<CachedEvent>)

    @Query("DELETE FROM clip_events WHERE user_id = :userId AND event_id IN (:ids)")
    suspend fun removeEvents(userId: String, ids: List<String>)

    @Query("DELETE FROM clip_events WHERE user_id = :userId")
    suspend fun clearEvents(userId: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun enqueue(q: QueuedEvent)

    @Query("DELETE FROM clip_queue WHERE user_id = :userId AND event_id = :id")
    suspend fun dequeue(userId: String, id: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putDeletes(d: List<PendingDelete>)

    @Query("DELETE FROM clip_deletes WHERE user_id = :userId AND event_id = :id")
    suspend fun forgetDelete(userId: String, id: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putSync(s: SyncState)

    @Query("DELETE FROM clip_events")
    suspend fun wipeEvents()

    @Query("DELETE FROM clip_queue")
    suspend fun wipeQueue()

    @Query("DELETE FROM clip_deletes")
    suspend fun wipeDeletes()

    @Query("DELETE FROM clip_sync")
    suspend fun wipeSync()

    @Transaction
    suspend fun wipe() {
        wipeEvents()
        wipeQueue()
        wipeDeletes()
        wipeSync()
    }

    @Transaction
    suspend fun replace(userId: String, events: List<CachedEvent>, cursor: Long, syncedAt: Long) {
        clearEvents(userId)
        putEvents(events)
        putSync(SyncState(userId, cursor, syncedAt))
    }

    @Transaction
    suspend fun advance(userId: String, put: List<CachedEvent>, remove: List<String>, cursor: Long, syncedAt: Long) {
        if (remove.isNotEmpty()) removeEvents(userId, remove)
        putEvents(put)
        putSync(SyncState(userId, cursor, syncedAt))
    }

    @Transaction
    suspend fun markDeleted(userId: String, items: List<PendingDelete>) {
        val ids = items.map { it.eventId }
        for (id in ids) dequeue(userId, id)
        removeEvents(userId, ids)
        putDeletes(items)
    }
}

@Database(entities = [CachedEvent::class, QueuedEvent::class, PendingDelete::class, SyncState::class], version = 1, exportSchema = true)
abstract class ClipboardDatabase : RoomDatabase() {
    abstract fun clipboard(): ClipboardDao

    companion object {
        const val NAME = "clipboard.db"
    }
}

/** What the engine reads at start. */
data class StoreSnapshot(
    val events: List<ClipboardEvent>,
    val queue: List<QueuedEvent>,
    val deletes: List<PendingDelete>,
    val sync: SyncState?
)

/**
 * The encrypted cache, offline queue, pending deletes and cursor of Clipboard Sync (docs/CLIPBOARD_PROTOCOL.md §2.9), in
 * Room. Ciphertext and ids only. [wipe] erases everything (sign-out, the account session ending) and starts a new
 * generation: an engine started before it can never write again, so a request that finishes after the wipe leaves no
 * record behind.
 */
open class ClipboardStore(private val dao: ClipboardDao) {
    private val lock = Mutex()
    private var gen = 0L

    suspend fun generation(): Long = lock.withLock { gen }

    open suspend fun snapshot(userId: String): StoreSnapshot = StoreSnapshot(
        dao.events(userId).map { it.toEvent() },
        dao.queue(userId),
        dao.deletes(userId),
        dao.sync(userId)
    )

    /** Runs [block] unless the store was wiped since [generation]; false when it was. */
    open suspend fun write(generation: Long, block: suspend (ClipboardDao) -> Unit): Boolean = lock.withLock {
        if (generation != gen) return false
        block(dao)
        true
    }

    open suspend fun wipe() = lock.withLock {
        gen++
        dao.wipe()
    }
}
