package app.shareanywhere

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.shareanywhere.ui.nav.ScreenIds
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Guest-first launch (docs/TESTING_AND_CI.md §5, PRD §5.1): a fresh install shows Welcome, Start sharing opens
 * Transfer home, no screen offers or requires signing in, Welcome is not on the back stack, and it is shown once.
 * The orchestrator clears app data before each test (clearPackageData), so this is a fresh install.
 */
@RunWith(AndroidJUnit4::class)
class GuestLaunchTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val signInLabels =
        listOf(R.string.android_signin, R.string.android_yy_signin, R.string.android_vv_k131, R.string.android_create_acc)
            .map { context.getString(it) }

    private fun assertNoSignIn() {
        compose.onNodeWithTag("signin").assertDoesNotExist()
        for (label in signInLabels) compose.onAllNodesWithText(label, substring = true).assertCountEquals(0)
    }

    @Test
    fun freshInstallGoesFromWelcomeToTransferHomeWithoutSignIn() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.waitForTag(ScreenIds.WELCOME)
            compose.onNodeWithTag(ScreenIds.WELCOME).assertIsDisplayed()
            assertNoSignIn()

            compose.onNodeWithTag("welcome.start").performClick()
            compose.waitForTag(ScreenIds.HOME)
            compose.onNodeWithTag(ScreenIds.HOME).assertIsDisplayed()
            compose.onNodeWithTag(ScreenIds.WELCOME).assertDoesNotExist()
            assertNoSignIn()

            // Bottom navigation: Transfer, History, Devices, Settings; Clipboard hidden until accounts ship.
            compose.onNodeWithTag("nav.${ScreenIds.CLIPBOARD}").assertDoesNotExist()
            for (tab in listOf(ScreenIds.HISTORY, ScreenIds.DEVICES, ScreenIds.SETTINGS, ScreenIds.HOME)) {
                compose.onNodeWithTag("nav.$tab").performClick()
                compose.waitForTag(tab)
                compose.onNodeWithTag(tab).assertIsDisplayed()
                assertNoSignIn()
            }

            // Welcome is not on the back stack: Back from Transfer home leaves the app.
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            compose.waitUntil(5_000) { scenario.state == Lifecycle.State.DESTROYED }
            assertEquals(Lifecycle.State.DESTROYED, scenario.state)
        }

        // Shown once: the next launch opens Transfer home directly.
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitForTag(ScreenIds.HOME)
            compose.onNodeWithTag(ScreenIds.WELCOME).assertDoesNotExist()
        }
    }
}
