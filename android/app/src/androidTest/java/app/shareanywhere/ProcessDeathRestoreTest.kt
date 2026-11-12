package app.shareanywhere

import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextInput
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Process death during a receive (docs/phases/PHASE_9_HARDENING_RELEASE.md; PRD §6 "resume on next launch"): a guest
 * starts receiving a large file, then the app's transfer state is dropped as if the process had ended (the screen
 * closed, the receiver controller released: only what is persisted remains, the partial document, its bitmap and the
 * save folder). The launch path (`TransferRuntime.resumeUnfinished`, run by the Application once the identity is
 * ready) recreates the receiver from that, which resumes from the bitmap: the file completes with a matching SHA-256,
 * the bytes verified before the restart count as resumed, and no verified block arrives twice.
 *
 * The instrumentation shares the app's process, so the process itself cannot be killed from the test; dropping every
 * in-memory controller and resuming from storage exercises the same restore path.
 */
@RunWith(AndroidJUnit4::class)
class ProcessDeathRestoreTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val size = 192 * 1024 * 1024 + 7

    @Test
    fun aReceiveInterruptedByProcessDeathResumesFromItsBitmapOnTheNextLaunch() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        val runtime = entry.transferRuntime()
        val (file, sum) = TestPeer.file("restore-${System.nanoTime()}.bin", size)
        TestPeer(Backend.Peer.create()).use { peer ->
            val view = runBlocking { peer.peer.api.create(listOf(FileInput(file.name, file.length(), "application/octet-stream")), false) }
            runBlocking { peer.sender(view.id, file, view.files!!.single().id, "application/octet-stream") }
            ActivityScenario.launch(MainActivity::class.java).use {
                compose.dumpOnFailure {
                    compose.waitForTag(ScreenIds.HOME)
                    compose.onNodeWithTag("home.receive").tap()
                    compose.onNodeWithTag("receive.tab-code").tap()
                    compose.waitForTag(ScreenIds.RECEIVE_CODE)
                    compose.onNodeWithTag("receive.code-input").performTextInput(view.code!!)
                    compose.onNodeWithTag("receive.continue").tap()
                    compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
                    compose.onNodeWithTag("preview.receive").tap()
                    compose.waitForTag("rx.start", 30_000)
                    compose.onNodeWithTag("rx.start").tap()
                }
            }
            // Some blocks verified and persisted, the file not finished: the process "ends" here.
            val before = runBlocking {
                withTimeout(60_000) {
                    while (runtime.existingReceiver(view.id) == null) delay(100)
                    runtime.existingReceiver(view.id)!!.state.first { it.verified >= 4L * 1024 * 1024 }.verified
                }
            }
            assertTrue("interrupted mid-file", before < size)
            runtime.release(view.id)
            assertEquals(null, runtime.existingReceiver(view.id))

            // Next launch: the unfinished receive is found in storage and resumed.
            val resumed = runBlocking { runtime.resumeUnfinished() }
            assertTrue("the unfinished receive is resumed: $resumed", view.id in resumed)
            waitForReceiveEnd(view.id, 180_000)
            val state = runtime.existingReceiver(view.id)!!.state.value
            assertEquals(RxPhase.Completed, state.phase)
            assertTrue("bytes verified before the restart were kept (${state.resumedBytes})", state.resumedBytes > 0)
            assertEquals("no verified block arrives twice", 0, state.duplicates)
            assertEquals(sum, TestPeer.sha256(peer.context, state.files.single().documentUri!!.toUri()))
            deleteReceived(view.id)
            runBlocking { peer.peer.api.close(view.id) }
        }
    }
}
