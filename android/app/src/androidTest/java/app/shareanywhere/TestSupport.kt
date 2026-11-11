package app.shareanywhere

import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText

/** DataStore and the network are not Compose idling resources, so screens are awaited by their tags. */
fun ComposeTestRule.waitForTag(tag: String, timeoutMs: Long = 10_000) =
    waitUntil(timeoutMs) { onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

fun ComposeTestRule.waitForText(text: String, timeoutMs: Long = 10_000) =
    waitUntil(timeoutMs) { onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
