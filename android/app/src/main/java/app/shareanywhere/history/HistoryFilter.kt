package app.shareanywhere.history

import java.time.Instant
import java.time.ZoneId

/** The History screen's chips (Android design: All, Sent, Received, Failed). */
enum class HistoryChip { ALL, SENT, RECEIVED, FAILED }

/** Date presets, "All" first so a 90-day retention never hides entries by default (DESIGN_DEVIATIONS G18). */
enum class HistoryRange { ALL, DAYS_30, DAYS_7, TODAY }

/** Search and filters for HI-1: chip, file or device name, status, date range, peer device. */
data class HistoryFilter(
    val chip: HistoryChip = HistoryChip.ALL,
    val query: String = "",
    val status: HistoryStatus? = null,
    val range: HistoryRange = HistoryRange.ALL,
    val peer: String? = null
) {
    val isDefault: Boolean get() = this == HistoryFilter()
}

/** The peers of an entry: the per-receiver list when recorded, else the single peer name. */
fun HistoryEntry.peerNames(): List<String> {
    val list = peers?.filter { it.isNotBlank() }
    return if (!list.isNullOrEmpty()) list else listOfNotNull(peer.takeIf { it.isNotBlank() })
}

/** Every peer in the entries, sorted, for the device filter. */
fun historyPeers(entries: List<HistoryEntry>): List<String> = entries.flatMap { it.peerNames() }.distinct().sorted()

/** Start of a date window in epoch ms (0 = no lower bound); "today" uses the device's time zone. */
fun rangeStart(range: HistoryRange, now: Long, zone: ZoneId = ZoneId.systemDefault()): Long = when (range) {
    HistoryRange.ALL -> 0
    HistoryRange.DAYS_30 -> now - 30 * HistoryRepository.DAY_MS
    HistoryRange.DAYS_7 -> now - 7 * HistoryRepository.DAY_MS
    HistoryRange.TODAY ->
        Instant
            .ofEpochMilli(now)
            .atZone(zone)
            .toLocalDate()
            .atStartOfDay(zone)
            .toInstant()
            .toEpochMilli()
}

/** Same matching as the Web's `filterHistory`, plus the design's Failed chip. */
fun filterHistory(entries: List<HistoryEntry>, f: HistoryFilter, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<HistoryEntry> {
    val q = f.query.trim().lowercase()
    val since = rangeStart(f.range, now, zone)
    return entries.filter { e ->
        val chipOk =
            when (f.chip) {
                HistoryChip.ALL -> true
                HistoryChip.SENT -> e.direction == Direction.SENT
                HistoryChip.RECEIVED -> e.direction == Direction.RECEIVED
                HistoryChip.FAILED -> e.status == HistoryStatus.FAILED
            }
        chipOk &&
            (f.status == null || e.status == f.status) &&
            (f.peer == null || f.peer in e.peerNames()) &&
            e.createdAt >= since &&
            (q.isEmpty() || e.searchable().any { it.lowercase().contains(q) })
    }
}

/** Bytes that moved: the recorded count, else the full size for a completed entry, else unknown. */
fun HistoryEntry.transferred(): Long? = transferredBytes ?: if (status == HistoryStatus.COMPLETED) totalBytes else null

private fun HistoryEntry.searchable(): List<String> = listOf(title, peer) + peerNames() + files.orEmpty().map { it.name }
