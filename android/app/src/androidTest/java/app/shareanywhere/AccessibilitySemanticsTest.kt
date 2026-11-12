package app.shareanywhere

import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.shareanywhere.ui.nav.ScreenIds
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Accessibility pass on the main screens ([accessibilityProblems]; the transfer, session and receive screens are audited
 * inside SenderSessionTest and TransferTest) (docs/phases/PHASE_9_HARDENING_RELEASE.md), the automated part of the TalkBack
 * review: on every screen, each control TalkBack can activate (a node with a click action in the merged semantics tree)
 * has a spoken name (text or content description) and a touch target of at least 48 × 48 dp (Material's minimum,
 * Accessibility Scanner's "touch target" check). Contrast and a spoken walkthrough are on the real-device checklist.
 */
@RunWith(AndroidJUnit4::class)
class AccessibilitySemanticsTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun audit(screen: String) = compose.accessibilityProblems(screen)

    @Test
    fun everyControlOnTheMainScreensHasANameAndA48dpTarget() {
        val problems = mutableListOf<String>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.dumpOnFailure {
                compose.waitForTag(ScreenIds.WELCOME)
                problems += audit(ScreenIds.WELCOME)
                compose.onNodeWithTag("welcome.start").tap()
                compose.waitForTag(ScreenIds.HOME)
                problems += audit(ScreenIds.HOME)
                for (tab in listOf(ScreenIds.CLIPBOARD, ScreenIds.HISTORY, ScreenIds.DEVICES, ScreenIds.SETTINGS, ScreenIds.HOME)) {
                    compose.onNodeWithTag("nav.$tab").tap()
                    compose.waitForTag(tab)
                    compose.waitForIdle()
                    problems += audit(tab)
                }
                compose.onNodeWithTag("home.send").tap()
                compose.waitForTag(ScreenIds.SEND)
                problems += audit(ScreenIds.SEND)
                // Send is a full-screen step without the bottom bar: Back returns to Transfer home.
                scenario.onActivity { a -> a.onBackPressedDispatcher.onBackPressed() }
                compose.waitForTag(ScreenIds.HOME)
                compose.onNodeWithTag("home.receive").tap()
                compose.waitForTag(ScreenIds.RECEIVE)
                compose.onNodeWithTag("receive.tab-code").tap()
                compose.waitForIdle()
                problems += audit(ScreenIds.RECEIVE_CODE)
            }
        }
        assertTrue("accessibility problems:\n" + problems.joinToString("\n"), problems.isEmpty())
    }
}
