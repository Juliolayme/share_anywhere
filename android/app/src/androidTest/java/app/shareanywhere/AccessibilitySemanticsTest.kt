package app.shareanywhere

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.shareanywhere.ui.nav.ScreenIds
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Accessibility pass on the main screens (docs/phases/PHASE_9_HARDENING_RELEASE.md), the automated part of the TalkBack
 * review: on every screen, each control TalkBack can activate (a node with a click action in the merged semantics tree)
 * has a spoken name (text or content description) and a touch target of at least 48 × 48 dp (Material's minimum,
 * Accessibility Scanner's "touch target" check). Contrast and a spoken walkthrough are on the real-device checklist.
 */
@RunWith(AndroidJUnit4::class)
class AccessibilitySemanticsTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun SemanticsNode.label(): String {
        val c = config
        val text = c.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
        val edit = c.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
        val desc = c.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()
        return listOf(text, edit, desc).joinToString(" ").trim()
    }

    private fun SemanticsNode.all(): List<SemanticsNode> = listOf(this) + children.flatMap { it.all() }

    /** Problems on the current screen, as readable lines (empty when the screen passes). */
    private fun audit(screen: String): List<String> {
        val root = compose.onRoot().fetchSemanticsNode()
        val minPx = with(compose.density) { 48.dp.toPx() } - 1f // rounding
        val problems = mutableListOf<String>()
        for (n in root.all()) {
            if (n.config.getOrNull(SemanticsActions.OnClick) == null) continue
            if (n.config.contains(SemanticsProperties.InvisibleToUser)) continue
            val tag = n.config.getOrNull(SemanticsProperties.TestTag) ?: "#${n.id}"
            if (n.label().isEmpty()) problems += "$screen: $tag has no spoken name"
            val b = n.touchBoundsInRoot
            if (b.width < minPx || b.height < minPx) {
                problems += "$screen: $tag touch target ${b.width.toInt()}×${b.height.toInt()} px is under 48 dp"
            }
        }
        return problems
    }

    @Test
    fun everyControlOnTheMainScreensHasANameAndA48dpTarget() {
        val problems = mutableListOf<String>()
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.dumpOnFailure {
                compose.waitForTag(ScreenIds.WELCOME)
                problems += audit(ScreenIds.WELCOME)
                compose.onNodeWithTag("welcome.start").performClick()
                compose.waitForTag(ScreenIds.HOME)
                problems += audit(ScreenIds.HOME)
                for (tab in listOf(ScreenIds.CLIPBOARD, ScreenIds.HISTORY, ScreenIds.DEVICES, ScreenIds.SETTINGS, ScreenIds.HOME)) {
                    compose.onNodeWithTag("nav.$tab").performClick()
                    compose.waitForTag(tab)
                    compose.waitForIdle()
                    problems += audit(tab)
                }
                compose.onNodeWithTag("home.send").performClick()
                compose.waitForTag(ScreenIds.SEND)
                problems += audit(ScreenIds.SEND)
                compose.onNodeWithTag("nav.${ScreenIds.HOME}").performClick()
                compose.waitForTag(ScreenIds.HOME)
                compose.onNodeWithTag("home.receive").performClick()
                compose.waitForTag(ScreenIds.RECEIVE)
                compose.onNodeWithTag("receive.tab-code").performClick()
                compose.waitForIdle()
                problems += audit(ScreenIds.RECEIVE_CODE)
            }
        }
        assertTrue("accessibility problems:\n" + problems.joinToString("\n"), problems.isEmpty())
    }
}
