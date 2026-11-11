package app.shareanywhere.history

import kotlinx.coroutines.flow.Flow

/** How long local History keeps entries (Settings › Privacy & retention). Stored values match the Web's. */
enum class Retention(val stored: String, val days: Int) {
    DAYS_30("30", 30),
    DAYS_90("90", 90),
    NONE("none", 0)
    ;

    companion object {
        val DEFAULT = DAYS_30

        fun fromStored(v: String?): Retention = entries.firstOrNull { it.stored == v } ?: DEFAULT
    }
}

/** Told about deletions made by the user, so synced copies are tombstoned too (cloud history sync, signed in only). */
interface HistorySyncHandler {
    fun removed(ids: List<String>)

    fun cleared()
}

/** Local History store for guests and signed-in users alike (PRD §2 History: Room on Android). */
class HistoryRepository(private val dao: HistoryDao, private val clock: () -> Long = System::currentTimeMillis) {
    /** Set while history sync is on for an added device; null for guests. */
    @Volatile var syncHandler: HistorySyncHandler? = null

    suspend fun list(): List<HistoryEntry> = dao.all()

    fun observeAll(): Flow<List<HistoryEntry>> = dao.observeAll()

    fun observe(id: String): Flow<HistoryEntry?> = dao.observe(id)

    /** Writes [entry] unless the user deleted the same id in the last 7 days. */
    suspend fun add(entry: HistoryEntry): Boolean = dao.addUnlessRemoved(entry, clock() - REMOVED_TTL_MS)

    /** The user deleted an entry: removed here, and its synced copy tombstoned when history sync is on. */
    suspend fun remove(id: String) {
        removeLocal(id)
        syncHandler?.removed(listOf(id))
    }

    /** Removes an entry on this device only (a tombstone pulled from the account). */
    suspend fun removeLocal(id: String) {
        val now = clock()
        dao.removeAndRemember(listOf(id), now, now - REMOVED_TTL_MS, REMOVED_MAX)
    }

    /** Clear all; [sync] also tombstones the synced copies when history sync is on (not on sign-out). */
    suspend fun clear(sync: Boolean = true) {
        val now = clock()
        dao.clearAndRemember(now, now - REMOVED_TTL_MS, REMOVED_MAX)
        if (sync) syncHandler?.cleared()
    }

    /** Deletes entries older than the retention period ("none" deletes all). Returns the count removed. */
    suspend fun sweep(retention: Retention, now: Long = clock()): Int = if (retention.days == 0) {
        dao.deleteCreatedAtOrBefore(Long.MAX_VALUE)
    } else {
        dao.deleteCreatedAtOrBefore(now - retention.days * DAY_MS)
    }

    companion object {
        const val DAY_MS = 24L * 60 * 60 * 1000

        /** Longer than any session lives (72 h signed in), as on the Web. */
        const val REMOVED_TTL_MS = 7 * DAY_MS
        const val REMOVED_MAX = 500
    }
}
