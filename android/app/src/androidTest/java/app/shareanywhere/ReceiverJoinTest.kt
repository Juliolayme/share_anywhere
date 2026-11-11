package app.shareanywhere

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.shareanywhere.data.api.Decision
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Guest receiver against the CI backend: joining with a code is immediate with open join (no approval step, no
 * sign-in), both sides see the same security words; a share link (App Link intent) with Require approval waits on
 * `rx-wait` with the screen kept on until the sender approves; an unknown code shows the lookup error.
 */
@RunWith(AndroidJUnit4::class)
class ReceiverJoinTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun createSession(sender: Backend.Peer, approval: Boolean) = runBlocking {
        sender.api.create(listOf(FileInput("trip.mp4", 1_048_576, "video/mp4"), FileInput("notes.txt", 12, "text/plain")), approval)
    }

    @Test
    fun guestJoinsWithACodeImmediatelyAndSeesTheSameSecurityWords() {
        Backend.assume()
        Backend.markWelcomed()
        val sender = Backend.Peer.create()
        val session = createSession(sender, approval = false)
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitForTag(ScreenIds.HOME)
            compose.onNodeWithTag("home.receive").performClick()
            compose.waitForTag(ScreenIds.RECEIVE)
            compose.onNodeWithTag("receive.tab-code").performClick()
            compose.waitForTag(ScreenIds.RECEIVE_CODE)
            compose.onNodeWithTag("receive.code-input").performTextInput(checkNotNull(session.code))
            compose.onNodeWithTag("receive.continue").performClick()

            compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
            compose.waitForText(sender.displayName)
            compose.waitForText("trip.mp4")
            compose.onNodeWithTag("preview.receive").performClick()

            // Open join: straight in, no approval step.
            compose.waitForTag(ScreenIds.RX_SAVE, 20_000)
            val receiver = runBlocking { sender.api.get(session.id).participants.orEmpty().single { it.role == "receiver" } }
            assertEquals("JOINED", receiver.status)
            compose.waitForText(receiver.securityWords.orEmpty().joinToString(" · "))
            assertFalse(Backend.entry().keepAwake().screenOn.value)
        }
    }

    @Test
    fun aShareLinkWithApprovalWaitsWithTheScreenOnUntilApproved() {
        Backend.assume()
        Backend.markWelcomed()
        val sender = Backend.Peer.create()
        val session = createSession(sender, approval = true)
        val link = checkNotNull(session.joinUrl)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link), ApplicationProvider.getApplicationContext(), MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
            compose.waitForText(sender.displayName)
            compose.onNodeWithTag("preview.receive").performClick()

            compose.waitForTag(ScreenIds.RX_WAIT, 20_000)
            compose.onNodeWithTag("keep-open-banner").assertExists()
            compose.waitUntil(5_000) { Backend.entry().keepAwake().screenOn.value }
            scenario.onActivity { assertTrue(it.keepsScreenOn()) }

            val requested = runBlocking { sender.api.get(session.id).participants.orEmpty().single { it.role == "receiver" } }
            assertEquals("REQUESTED", requested.status)
            runBlocking { sender.api.decide(requested.id, Decision.Approve) }

            compose.waitForTag(ScreenIds.RX_SAVE, 20_000)
            compose.waitUntil(5_000) { !Backend.entry().keepAwake().screenOn.value }
            scenario.onActivity { assertFalse(it.keepsScreenOn()) }
        }
    }

    @Test
    fun anUnknownCodeShowsTheLookupError() {
        Backend.assume()
        Backend.markWelcomed()
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitForTag(ScreenIds.HOME)
            compose.onNodeWithTag("home.receive").performClick()
            compose.onNodeWithTag("receive.tab-code").performClick()
            compose.waitForTag(ScreenIds.RECEIVE_CODE)
            // Six digits no session uses right now (codes are random; a collision would join, which also fails the test loudly).
            compose.onNodeWithTag("receive.code-input").performTextInput("000000")
            compose.onNodeWithTag("receive.continue").performClick()
            compose.waitForTag("receive.error", 20_000)
            compose.waitForText(Backend.entryString(R.string.common_nf_rx))
        }
    }
}
