package app.shareanywhere

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.shareanywhere.di.AppEntryPoint
import app.shareanywhere.history.Direction
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryFile
import app.shareanywhere.history.HistoryStatus
import app.shareanywhere.ui.nav.ScreenIds
import dagger.hilt.android.EntryPointAccessors
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Local History lives in Room and survives Activity recreation and a relaunch (docs/UX_SCREEN_MAP.md HI-1, HI-2). */
@RunWith(AndroidJUnit4::class)
class HistoryPersistenceTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val deps = EntryPointAccessors.fromApplication(app, AppEntryPoint::class.java)
    private val entry =
        HistoryEntry(
            id = "rx:instrumentation-1",
            direction = Direction.RECEIVED,
            title = "holiday-photos.zip",
            fileCount = 1,
            totalBytes = 2_400_000_000,
            peer = "Office PC",
            status = HistoryStatus.COMPLETED,
            createdAt = System.currentTimeMillis() - 60_000,
            files = listOf(HistoryFile("holiday-photos.zip", 2_400_000_000))
        )
    private val row = "history.row.${entry.id}"

    @Test
    fun localHistorySurvivesActivityRecreationAndRelaunch() {
        // Seeded through the app's own repository: transfers that write History arrive in milestone 6.2.
        runBlocking {
            deps.settingsRepository().markWelcomed()
            deps.historyRepository().add(entry)
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.waitForTag(ScreenIds.HOME)
            compose.waitForTag(row)
            compose.onNodeWithTag("nav.${ScreenIds.HISTORY}").performClick()
            compose.waitForTag(ScreenIds.HISTORY)
            compose.onNodeWithTag(row).assertIsDisplayed()

            scenario.recreate()
            compose.waitForTag(ScreenIds.HISTORY)
            compose.waitForTag(row)
            compose.onNodeWithTag(row).assertIsDisplayed().performClick()
            compose.waitForTag(ScreenIds.HISTORY_DETAIL)

            scenario.recreate()
            compose.waitForTag(ScreenIds.HISTORY_DETAIL)
        }
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitForTag(ScreenIds.HOME)
            compose.waitForTag(row)
        }
    }
}
