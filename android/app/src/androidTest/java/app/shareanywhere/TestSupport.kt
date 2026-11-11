package app.shareanywhere

import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.printToLog
import app.shareanywhere.transfer.runtime.final
import kotlinx.coroutines.flow.first

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

/**
 * Waits for a receive to end by watching the runtime's state, not the UI: polling the semantics tree every few
 * milliseconds through a long transfer re-enters Espresso's main-thread loop during frames (seen as "performMeasureAndLayout
 * called during measure layout" in CI). The final screen is checked once afterwards.
 */
fun waitForReceiveEnd(sessionId: String, timeoutMs: Long) = kotlinx.coroutines.runBlocking {
    kotlinx.coroutines.withTimeout(timeoutMs) {
        val rt = Backend.entry().transferRuntime()
        while (rt.existingReceiver(sessionId) == null) kotlinx.coroutines.delay(200)
        rt.existingReceiver(sessionId)!!.state.first { it.phase.final() }
    }
}

/** The sender's counterpart of [waitForReceiveEnd]: the session result is known. */
fun waitForSendEnd(sessionId: String, timeoutMs: Long) = kotlinx.coroutines.runBlocking {
    kotlinx.coroutines.withTimeout(timeoutMs) { Backend.entry().transferRuntime().sender(sessionId).state.first { it.final != null } }
}

/**
 * Deletes what a test received (files in Download/Share Anywhere outlive clearPackageData, and a few large receives
 * would fill the emulator's storage for the next tests).
 */
fun deleteReceived(sessionId: String) {
    val rx = Backend.entry().transferRuntime().existingReceiver(sessionId) ?: return
    val resolver = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
    for (f in rx.state.value.files) {
        val uri = f.documentUri?.let(android.net.Uri::parse) ?: continue
        runCatching {
            if (android.provider.DocumentsContract.isDocumentUri(androidx.test.core.app.ApplicationProvider.getApplicationContext(), uri)) {
                android.provider.DocumentsContract.deleteDocument(resolver, uri)
            } else {
                resolver.delete(uri, null, null)
            }
        }
    }
}
