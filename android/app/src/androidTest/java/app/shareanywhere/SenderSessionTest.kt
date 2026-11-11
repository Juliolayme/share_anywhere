package app.shareanywhere

import android.Manifest
import android.content.Intent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.notify.Notifier
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Guest sender against the CI backend (docs/phases/PHASE_6_ANDROID.md "Tests to add"): the session screen shows the
 * code and keeps the screen on while the join window is open; a receiver joins with the code (open join, no approval
 * step); the window expires (test clock) into "Code expired — Create new code" without affecting the joined receiver;
 * Create new code; Remove; Require approval and Approve; Block; Close. No step signs in.
 */
@RunWith(AndroidJUnit4::class)
class SenderSessionTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (android.os.Build.VERSION.SDK_INT >=
            33
        ) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    private fun sessionIntent(id: String) = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
        .setAction(Notifier.ACTION_OPEN_SESSION)
        .putExtra(Notifier.EXTRA_SESSION_ID, id)

    private fun code(): String {
        val node = compose.onNodeWithTag("session-code").fetchSemanticsNode()
        return node.config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString("") { it.text }.replace(" ", "")
    }

    @Test
    fun guestSenderSharesACodeAndManagesReceivers() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        // The app's own device creates the session, exactly as Create share session does after the SAF picker.
        val view = runBlocking { entry.sessionsApi().create(listOf(FileInput("notes.txt", 12, "text/plain")), requireApproval = false) }
        val firstCode = checkNotNull(view.code)

        ActivityScenario.launch<MainActivity>(sessionIntent(view.id)).use { scenario ->
            compose.waitForTag(ScreenIds.SESSION, 30_000)
            assertEquals(firstCode, code())
            compose.onNodeWithTag("countdown").assertExists()
            compose.onNodeWithTag("keep-open-banner").assertExists()
            compose.waitUntil(5_000) { entry.keepAwake().screenOn.value }
            scenario.onActivity { assertTrue("window keeps the screen on while the join window is open", it.keepsScreenOn()) }

            // A guest receiver joins with the code: open join admits it at once.
            val alice = Backend.Peer.create()
            val joined = runBlocking { alice.api.resolveCode(firstCode).let { alice.api.join(it.sessionId, it.joinTicket) } }
            assertEquals("JOINED", joined.participant.status)
            compose.waitForTag("participant-card", 20_000)
            val words = runBlocking { alice.api.get(view.id).me?.securityWords.orEmpty() }
            assertEquals(3, words.size)
            compose.waitForText(words.joinToString(" · "))

            // The join window ends (test clock): expired state, screen released, the joined receiver keeps its place.
            Backend.advanceClock(601)
            compose.waitForTag(ScreenIds.SESSION_EXPIRED, 30_000)
            compose.onNodeWithTag("code-expired").assertExists()
            compose.waitUntil(5_000) { !entry.keepAwake().screenOn.value }
            scenario.onActivity { assertFalse(it.keepsScreenOn()) }
            assertEquals("JOINED", runBlocking { alice.api.get(view.id).me?.status })

            // Create new code: a fresh window and a different code.
            compose.onNodeWithTag("session.renew").performClick()
            compose.waitForTag(ScreenIds.SESSION, 20_000)
            assertNotEquals(firstCode, code())
            val secondCode = code()

            // Remove revokes the receiver at once.
            compose.onNodeWithTag("participant.remove").performClick()
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("participant-card").fetchSemanticsNodes().isEmpty() }
            assertEquals("REMOVED", runBlocking { alice.api.get(view.id).me?.status })

            // Require approval: the next receiver waits for Approve.
            compose.onNodeWithTag("session.approval").performClick()
            compose.waitUntil(20_000) { runBlocking { entry.sessionsApi().get(view.id).requireApproval } }
            val bob = Backend.Peer.create("Safari on iPhone")
            val requested = runBlocking { bob.api.resolveCode(secondCode).let { bob.api.join(it.sessionId, it.joinTicket) } }
            assertEquals("REQUESTED", requested.participant.status)
            compose.waitForTag("request-card", 20_000)
            compose.onNodeWithTag("participant.approve").performClick()
            compose.waitForTag("participant-card", 20_000)
            assertEquals("JOINED", runBlocking { bob.api.get(view.id).me?.status })

            // Block, after the confirmation dialog.
            compose.onNodeWithTag("participant.block").performClick()
            compose.onNodeWithText(Backend.entryString(R.string.product_block_confirm_h)).assertExists()
            compose.onNodeWithTag("dialog.confirm").performClick()
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("participant-card").fetchSemanticsNodes().isEmpty() }
            assertEquals("BLOCKED", runBlocking { bob.api.get(view.id).me?.status })

            // Close from the TR-8 sheet ends the session.
            compose.onNodeWithContentDescription(Backend.entryString(R.string.android_close)).performClick()
            compose.waitForTag("session.close-confirm")
            compose.onNodeWithTag("session.close-confirm").performClick()
            compose.waitForTag("session.ended", 20_000)
            assertEquals("CLOSED", runBlocking { entry.sessionsApi().get(view.id).status })
        }
    }
}
