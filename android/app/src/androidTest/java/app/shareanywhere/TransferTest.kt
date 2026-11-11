package app.shareanywhere

import android.Manifest
import android.content.Intent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.rule.GrantPermissionRule
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.history.HistoryStatus
import app.shareanywhere.notify.Notifier
import app.shareanywhere.transfer.OutgoingFile
import app.shareanywhere.transfer.SaveTarget
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.transfer.storage.Folders
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real transfers on the emulator (docs/phases/PHASE_6_ANDROID.md): WebRTC DataChannel through the CI backend's
 * signaling, the Phase 3 wire protocol, SHA-256 verification, History. The other side is a second guest device in the
 * test process ([TestPeer]). Interop with the Web app is the nightly android-web-interop job.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 29) // the default Download/Share Anywhere target uses MediaStore (Android 10+)
class TransferTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (android.os.Build.VERSION.SDK_INT >=
            33
        ) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    private val size = 9 * 1024 * 1024 + 123 // three blocks, the last one partial

    @Test
    fun guestSendsAFileToAnotherDeviceAndSeesItDelivered() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        val (file, sum) = TestPeer.file("send-${System.nanoTime()}.bin", size)
        val view =
            runBlocking {
                entry.sessionsApi().create(listOf(FileInput(file.name, file.length(), "application/octet-stream")), requireApproval = false)
            }
        // What Create share session stores after the SAF picker: the server's file id mapped to the document.
        runBlocking {
            entry.outgoingFiles().insertAll(
                listOf(
                    OutgoingFile(
                        view.id,
                        view.files!!.single().id,
                        0,
                        file.toUri().toString(),
                        file.name,
                        file.length(),
                        "application/octet-stream",
                        System.currentTimeMillis()
                    )
                )
            )
        }
        val intent = Intent(
            ApplicationProvider.getApplicationContext(),
            MainActivity::class.java
        ).setAction(Notifier.ACTION_OPEN_SESSION).putExtra(Notifier.EXTRA_SESSION_ID, view.id)
        TestPeer(Backend.Peer.create()).use { peer ->
            ActivityScenario.launch<MainActivity>(intent).use { scenario ->
                compose.dumpOnFailure {
                    compose.waitForTag(ScreenIds.SESSION, 30_000)
                    val joined =
                        runBlocking { peer.peer.api.resolveCode(view.code!!).let { peer.peer.api.join(it.sessionId, it.joinTicket) } }
                    assertEquals("JOINED", joined.participant.status)
                    val rx = peer.receiver(view.id)
                    runBlocking { withTimeout(20_000) { rx.state.first { it.phase == RxPhase.Choose } } }
                    rx.start(SaveTarget(view.id, Folders.DEFAULT_DOWNLOADS, Folders.DEFAULT_LABEL, System.currentTimeMillis()))

                    compose.waitForTag("session.dashboard", 20_000)
                    compose.onNodeWithTag("session.dashboard").tap()
                    waitForSendEnd(view.id, 120_000)
                    compose.waitForTag(ScreenIds.DASHBOARD_DONE, 30_000)
                    val done = runBlocking { withTimeout(30_000) { rx.state.first { it.phase == RxPhase.Completed } } }
                    assertEquals(sum, TestPeer.sha256(peer.context, done.files.single().documentUri!!.toUri()))
                    // Nothing is moving any more: the window no longer keeps the screen on.
                    compose.waitUntil(10_000) { !entry.keepAwake().screenOn.value }
                    scenario.onActivity { assertFalse(it.keepsScreenOn()) }
                    val sent =
                        runBlocking { withTimeout(10_000) { entry.historyRepository().observe("tx:${view.id}").first { it != null } } }
                    assertEquals(HistoryStatus.COMPLETED, sent!!.status)
                    runBlocking { entry.sessionsApi().close(view.id) }
                }
            }
        }
    }

    @Test
    fun guestReceivesAFileIntoDownloadsAndVerifiesIt() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        val (file, sum) = TestPeer.file("receive-${System.nanoTime()}.bin", size)
        TestPeer(Backend.Peer.create()).use { peer ->
            val view = runBlocking { peer.peer.api.create(listOf(FileInput(file.name, file.length(), "application/octet-stream")), false) }
            runBlocking { peer.sender(view.id, file, view.files!!.single().id, "application/octet-stream") }
            ActivityScenario.launch(MainActivity::class.java).use {
                compose.dumpOnFailure {
                    compose.waitForTag(ScreenIds.HOME)
                    compose.onNodeWithTag("home.receive").performClick()
                    compose.onNodeWithTag("receive.tab-code").performClick()
                    compose.waitForTag(ScreenIds.RECEIVE_CODE)
                    compose.onNodeWithTag("receive.code-input").performTextInput(view.code!!)
                    compose.onNodeWithTag("receive.continue").performClick()
                    compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
                    compose.onNodeWithTag("preview.receive").tap()
                    // RX-5b: Download/Share Anywhere is preselected, so Start receiving is ready.
                    compose.waitForTag("rx.start", 30_000)
                    compose.onNodeWithTag("rx.start").tap()
                    waitForReceiveEnd(view.id, 120_000)
                    compose.waitForTag(ScreenIds.RX_DONE, 30_000)
                    compose.onNodeWithTag("rx.result").assertExists()
                    val rx = entry.transferRuntime().existingReceiver(view.id)!!
                    val state = rx.state.value
                    assertEquals(RxPhase.Completed, state.phase)
                    assertEquals(sum, TestPeer.sha256(peer.context, state.files.single().documentUri!!.toUri()))
                    assertFalse(entry.keepAwake().screenOn.value)
                    val got =
                        runBlocking { withTimeout(10_000) { entry.historyRepository().observe("rx:${view.id}").first { it != null } } }
                    assertEquals(HistoryStatus.COMPLETED, got!!.status)
                    runBlocking { peer.peer.api.close(view.id) }
                }
            }
        }
    }
}
