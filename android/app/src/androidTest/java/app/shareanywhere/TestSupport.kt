package app.shareanywhere

import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.printToLog

/** DataStore and the network are not Compose idling resources, so screens are awaited by their tags. */
fun ComposeTestRule.waitForTag(tag: String, timeoutMs: Long = 10_000) =
    waitUntil(timeoutMs) { onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

fun ComposeTestRule.waitForText(text: String, timeoutMs: Long = 10_000) =
    waitUntil(timeoutMs) { onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

/** Whether any view in the Activity window asks to keep the screen on (FLAG_KEEP_SCREEN_ON via View.keepScreenOn). */
fun android.app.Activity.keepsScreenOn(): Boolean {
    fun walk(v: android.view.View): Boolean =
        v.keepScreenOn || (v is android.view.ViewGroup && (0 until v.childCount).any { walk(v.getChildAt(it)) })
    return walk(window.decorView)
}

/**
 * Scrolls a control into view and invokes its click action through semantics (as TalkBack does), so a transient
 * overlay such as a snackbar over the bottom of the screen cannot swallow the tap.
 */
fun androidx.compose.ui.test.SemanticsNodeInteraction.tap(): androidx.compose.ui.test.SemanticsNodeInteraction {
    runCatching { performScrollTo() }
    return performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
}

/** Runs [block]; on failure prints the semantics tree to logcat (tag SA-TREE, kept in the CI artifact) and rethrows. */
inline fun <T> ComposeTestRule.dumpOnFailure(block: () -> T): T = try {
    block()
} catch (e: Throwable) {
    runCatching { onRoot(useUnmergedTree = true).printToLog("SA-TREE") }
    throw e
}
