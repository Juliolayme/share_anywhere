package app.shareanywhere.history

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable

enum class Direction(val wire: String) { SENT("sent"), RECEIVED("received") }

enum class HistoryStatus(val wire: String) { COMPLETED("completed"), PARTIAL("partial"), FAILED("failed"), CANCELLED("cancelled") }

/** How the bytes travelled: one route for every receiver, or a mix. */
enum class HistoryRoute(val wire: String) { DIRECT("direct"), RELAY("relay"), MIXED("mixed") }

/** One file of an entry. */
@Serializable
data class HistoryFile(
    val name: String,
    val size: Long,
    /** Bytes that arrived or were verified when the transfer ended short of [size]. */
    val transferredBytes: Long? = null
)

/**
 * One local History entry (PRD §2 History, docs/UX_SCREEN_MAP.md HI-1). Fields mirror the Web entry
 * (`web/src/features/history/store/history-store.ts`) so cloud history sync (milestone 6.4) can carry the same
 * JSON between clients. Guest history never leaves the device.
 */
@Entity(tableName = "history", indices = [Index("created_at")])
data class HistoryEntry(
    @PrimaryKey val id: String,
    val direction: Direction,
    /** Main file name, or a summary such as "3 files". */
    val title: String,
    @ColumnInfo(name = "file_count") val fileCount: Int,
    @ColumnInfo(name = "total_bytes") val totalBytes: Long,
    /** Bytes that arrived (or were verified) when the transfer ended short of [totalBytes]. */
    @ColumnInfo(name = "transferred_bytes") val transferredBytes: Long? = null,
    /** The other side's display name (receiver or sender). */
    val peer: String,
    val status: HistoryStatus,
    /** Epoch milliseconds when the transfer ended. */
    @ColumnInfo(name = "created_at") val createdAt: Long,
    /** Each peer's display name when there were several receivers; [peer] stays the joined summary. */
    val peers: List<String>? = null,
    /** Per-file names and sizes, for search by file name and the detail view. */
    val files: List<HistoryFile>? = null,
    val route: HistoryRoute? = null,
    /** Epoch milliseconds when the first byte moved; with [createdAt] it gives the duration. */
    @ColumnInfo(name = "started_at") val startedAt: Long? = null,
    /** Name of the account device this entry came from (cloud history sync, milestone 6.4). */
    val origin: String? = null
)

/**
 * An id the user deleted (one by one or with Clear all), remembered for [HistoryRepository.REMOVED_TTL_MS] so a
 * live session that rewrites its entry does not bring it back (same rule as the Web store).
 */
@Entity(tableName = "history_removed", indices = [Index("removed_at")])
data class RemovedHistoryId(@PrimaryKey val id: String, @ColumnInfo(name = "removed_at") val removedAt: Long)
