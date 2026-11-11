package app.shareanywhere.history

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Local History in Room (in-memory, Robolectric): same rules as the Web store. */
@RunWith(AndroidJUnit4::class)
class HistoryRepositoryTest {
    private lateinit var db: HistoryDatabase
    private var now = 1_800_000_000_000L
    private lateinit var repo: HistoryRepository
    private val day = HistoryRepository.DAY_MS

    private fun entry(id: String, ageDays: Long = 0) = HistoryEntry(
        id = id,
        direction = Direction.RECEIVED,
        title = "video.mp4",
        fileCount = 2,
        totalBytes = 4_000_000_000,
        transferredBytes = 1_000_000_000,
        peer = "Office PC",
        status = HistoryStatus.PARTIAL,
        createdAt = now - ageDays * day,
        peers = listOf("Office PC"),
        files = listOf(HistoryFile("video.mp4", 3_000_000_000, 1_000_000_000), HistoryFile("notes.txt", 1_000_000_000)),
        route = HistoryRoute.MIXED,
        startedAt = now - ageDays * day - 60_000,
        origin = null
    )

    @Before
    fun setUp() {
        db =
            Room
                .inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HistoryDatabase::class.java)
                .allowMainThreadQueries()
                .build()
        repo = HistoryRepository(db.history()) { now }
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun storesEveryFieldAndListsNewestFirst() = runBlocking {
        repo.add(entry("old", ageDays = 2))
        repo.add(entry("new"))
        val list = repo.observeAll().first()
        assertEquals(listOf("new", "old"), list.map { it.id })
        assertEquals(entry("new"), list.first())
        assertEquals(entry("old", 2), repo.observe("old").first())
    }

    @Test
    fun addReplacesTheSameId() = runBlocking {
        repo.add(entry("tx:s1"))
        repo.add(entry("tx:s1").copy(status = HistoryStatus.COMPLETED, transferredBytes = null))
        val list = repo.observeAll().first()
        assertEquals(1, list.size)
        assertEquals(HistoryStatus.COMPLETED, list.single().status)
    }

    @Test
    fun deletedEntriesAreNotWrittenAgainForSevenDays() = runBlocking {
        repo.add(entry("tx:s1"))
        repo.remove("tx:s1")
        assertFalse(repo.add(entry("tx:s1")))
        assertTrue(repo.observeAll().first().isEmpty())
        now += 7 * day + 1
        assertTrue(repo.add(entry("tx:s1")))
    }

    @Test
    fun clearRemovesEverythingAndRemembersTheIds() = runBlocking {
        repo.add(entry("a"))
        repo.add(entry("b"))
        repo.clear()
        assertTrue(repo.observeAll().first().isEmpty())
        assertFalse(repo.add(entry("a")))
        assertTrue(repo.add(entry("c")))
    }

    @Test
    fun sweepAppliesTheRetention() = runBlocking {
        repo.add(entry("today"))
        repo.add(entry("d45", ageDays = 45))
        repo.add(entry("d100", ageDays = 100))
        assertEquals(1, repo.sweep(Retention.DAYS_90))
        assertEquals(listOf("today", "d45"), repo.observeAll().first().map { it.id })
        assertEquals(1, repo.sweep(Retention.DAYS_30))
        assertEquals(1, repo.sweep(Retention.NONE))
        assertTrue(repo.observeAll().first().isEmpty())
    }

    @Test
    fun retentionValuesMatchTheWeb() {
        assertEquals(Retention.DAYS_30, Retention.fromStored(null))
        assertEquals(Retention.DAYS_90, Retention.fromStored("90"))
        assertEquals(Retention.NONE, Retention.fromStored("none"))
        assertEquals(Retention.DAYS_30, Retention.fromStored("bogus"))
    }
}
