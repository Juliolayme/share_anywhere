package app.shareanywhere.history

import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HistoryFilterTest {
    private val day = HistoryRepository.DAY_MS
    private val now = 1_800_000_000_000L
    private val utc = ZoneOffset.UTC

    private fun entry(
        id: String,
        direction: Direction = Direction.SENT,
        status: HistoryStatus = HistoryStatus.COMPLETED,
        ageDays: Double = 0.0,
        peer: String = "Lan's MacBook",
        peers: List<String>? = null,
        files: List<HistoryFile>? = null,
        title: String = "photo.jpg",
        transferred: Long? = null
    ) = HistoryEntry(
        id = id,
        direction = direction,
        title = title,
        fileCount = files?.size ?: 1,
        totalBytes = 1000,
        transferredBytes = transferred,
        peer = peer,
        status = status,
        createdAt = now - (ageDays * day).toLong(),
        peers = peers,
        files = files
    )

    private val all =
        listOf(
            entry("a", ageDays = 0.1, title = "Report.pdf"),
            entry("b", Direction.RECEIVED, HistoryStatus.FAILED, ageDays = 3.0, peer = "Office PC"),
            entry("c", status = HistoryStatus.PARTIAL, ageDays = 20.0, peers = listOf("Minh", "Office PC"), peer = "Minh, Office PC"),
            entry("d", Direction.RECEIVED, ageDays = 60.0, files = listOf(HistoryFile("RAW_day2.zip", 500), HistoryFile("notes.txt", 500)))
        )

    private fun ids(f: HistoryFilter) = filterHistory(all, f, now, utc).map { it.id }

    @Test
    fun chipsFilterDirectionAndFailures() {
        assertEquals(listOf("a", "b", "c", "d"), ids(HistoryFilter()))
        assertEquals(listOf("a", "c"), ids(HistoryFilter(chip = HistoryChip.SENT)))
        assertEquals(listOf("b", "d"), ids(HistoryFilter(chip = HistoryChip.RECEIVED)))
        assertEquals(listOf("b"), ids(HistoryFilter(chip = HistoryChip.FAILED)))
    }

    @Test
    fun searchMatchesTitlePeerAndFileNamesCaseInsensitively() {
        assertEquals(listOf("a"), ids(HistoryFilter(query = "  report ")))
        assertEquals(listOf("b", "c"), ids(HistoryFilter(query = "office")))
        assertEquals(listOf("d"), ids(HistoryFilter(query = "raw_DAY2")))
    }

    @Test
    fun statusDateAndPeerFilters() {
        assertEquals(listOf("c"), ids(HistoryFilter(status = HistoryStatus.PARTIAL)))
        assertEquals(listOf("a", "b"), ids(HistoryFilter(range = HistoryRange.DAYS_7)))
        assertEquals(listOf("a", "b", "c"), ids(HistoryFilter(range = HistoryRange.DAYS_30)))
        assertEquals(listOf("b", "c"), ids(HistoryFilter(peer = "Office PC")))
        assertEquals(listOf("Lan's MacBook", "Minh", "Office PC"), historyPeers(all))
    }

    @Test
    fun todayStartsAtLocalMidnight() {
        val midnight = rangeStart(HistoryRange.TODAY, now, utc)
        assertEquals(0, midnight % day)
        assertEquals(0L, rangeStart(HistoryRange.ALL, now, utc))
    }

    @Test
    fun transferredFallsBackToSizeOnlyForCompletedEntries() {
        assertEquals(1000L, entry("x").transferred())
        assertEquals(400L, entry("x", status = HistoryStatus.PARTIAL, transferred = 400).transferred())
        assertNull(entry("x", status = HistoryStatus.FAILED).transferred())
    }
}
