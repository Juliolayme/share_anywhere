package app.shareanywhere

import android.Manifest
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.UiDevice
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.transfer.runtime.final
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Keep screen on (docs/ARCHITECTURE.md §7, PRD §5.10) on the emulator: `FLAG_KEEP_SCREEN_ON` is set while the receive
 * screen shows bytes moving and cleared on pause, cancel and with the setting off; with the screen turned off the
 * transfer still completes (foreground service), and afterwards the held wake locks in `dumpsys power` include none of the app.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 29)
class KeepScreenOnTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (android.os.Build.VERSION.SDK_INT >=
            33
        ) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @After
    fun wake() {
        device.wakeUp()
        runBlocking { Backend.entry().settingsRepository().setKeepScreenOn(true) }
    }

    private fun windowKeepsOn(scenario: ActivityScenario<MainActivity>): Boolean {
        var on = false
        scenario.onActivity { on = it.keepsScreenOn() }
        return on
    }

    /** Starts a receive of [size] bytes from a second device; returns once `rx-progress` shows. */
    private fun receive(peer: TestPeer, size: Int, block: (sessionId: String, scenario: ActivityScenario<MainActivity>) -> Unit) {
        val (file, _) = TestPeer.file("keep-${System.nanoTime()}.bin", size)
        val view = runBlocking { peer.peer.api.create(listOf(FileInput(file.name, file.length(), "application/octet-stream")), false) }
        runBlocking { peer.sender(view.id, file, view.files!!.single().id, "application/octet-stream") }
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                compose.dumpOnFailure {
                    compose.waitForTag(ScreenIds.HOME)
                    compose.onNodeWithTag("home.receive").performClick()
                    compose.onNodeWithTag("receive.tab-code").performClick()
                    compose.waitForTag(ScreenIds.RECEIVE_CODE)
                    compose.onNodeWithTag("receive.code-input").performTextInput(view.code!!)
                    compose.onNodeWithTag("receive.continue").performClick()
                    compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
                    compose.onNodeWithTag("preview.receive").tap()
                    compose.waitForTag("rx.start", 30_000)
                    compose.onNodeWithTag("rx.start").tap()
                    block(view.id, scenario)
                }
            }
        } finally {
            deleteReceived(view.id)
            runBlocking { runCatching { peer.peer.api.close(view.id) } }
        }
    }

    @Test
    fun receivingKeepsTheScreenOnUntilPausedOrCancelled() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        TestPeer(Backend.Peer.create()).use { peer ->
            receive(peer, 64 * 1024 * 1024) { id, scenario ->
                compose.waitForTag("rx.pause", 60_000)
                compose.waitUntil(10_000) { entry.keepAwake().screenOn.value }
                compose.waitUntil(5_000) { windowKeepsOn(scenario) == true }
                // The first transfer of the process drives the runtime's activity and so the foreground service.
                compose.waitUntil(10_000) { entry.transferRuntime().activity.value.receiving }
                compose.waitUntil(10_000) { app.shareanywhere.transfer.TransferService.running }

                compose.onNodeWithTag("rx.pause").tap()
                compose.waitUntil(10_000) { !entry.keepAwake().screenOn.value }
                // The window flag follows on the next composition.
                compose.waitUntil(5_000) { windowKeepsOn(scenario) == false }

                compose.waitForTag("rx.resume", 10_000)
                compose.onNodeWithTag("rx.resume").tap()
                compose.waitUntil(20_000) {
                    entry.keepAwake().screenOn.value ||
                        entry.transferRuntime().existingReceiver(id)?.state?.value?.phase == RxPhase.Completed
                }

                if (entry.transferRuntime().existingReceiver(id)?.state?.value?.phase != RxPhase.Completed) {
                    compose.onNodeWithTag("rx.cancel-transfer").tap()
                    compose.onNodeWithTag("dialog.confirm").tap()
                    compose.waitUntil(20_000) { !entry.keepAwake().screenOn.value }
                }
                compose.waitUntil(5_000) { windowKeepsOn(scenario) == false }
            }
        }
    }

    @Test
    fun theTransferFinishesWithTheScreenOffAndNoWakeLockIsHeldAfter() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        TestPeer(Backend.Peer.create()).use { peer ->
            receive(peer, 32 * 1024 * 1024) { id, _ ->
                compose.waitForTag("rx.pause", 60_000)
                device.sleep()
                assertFalse(device.isScreenOn)
                val done =
                    runBlocking { withTimeout(180_000) { entry.transferRuntime().existingReceiver(id)!!.state.first { it.phase.final() } } }
                assertEquals("completes with the screen off (foreground service)", RxPhase.Completed, done.phase)
                device.wakeUp()
                // The wake lock and Wi-Fi lock are held only while bytes move.
                var locks = heldWakeLocks()
                for (i in 0 until 20) {
                    if (!locks.contains("ShareAnywhere:transfer")) break
                    Thread.sleep(500)
                    locks = heldWakeLocks()
                }
                assertFalse("no wake lock after completion:\n$locks", locks.contains("ShareAnywhere:transfer"))
            }
        }
    }

    @Test
    fun withTheSettingOffTheScreenIsNotKeptOn() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        runBlocking { entry.settingsRepository().setKeepScreenOn(false) }
        TestPeer(Backend.Peer.create()).use { peer ->
            receive(peer, 16 * 1024 * 1024) { id, scenario ->
                compose.waitUntil(60_000) {
                    val phase = entry.transferRuntime().existingReceiver(id)?.state?.value?.phase
                    phase == RxPhase.Transferring || phase == RxPhase.Completed
                }
                scenario.onActivity { assertFalse("setting off: never kept on", it.keepsScreenOn()) }
                assertFalse(entry.keepAwake().screenOn.value)
                runBlocking {
                    withTimeout(120_000) {
                        entry.transferRuntime().existingReceiver(id)!!.state.first {
                            it.phase ==
                                RxPhase.Completed
                        }
                    }
                }
            }
        }
    }

    /**
     * The "Wake Locks:" section of `dumpsys power` (locks held now). Android 14+ also prints a wake lock log of past
     * acquisitions and releases, which still names released locks.
     */
    private fun heldWakeLocks(): String {
        val dump = device.executeShellCommand("dumpsys power")
        val start = dump.indexOf("Wake Locks: size=")
        if (start < 0) return ""
        val end = dump.indexOf("\n\n", start).let { if (it < 0) dump.length else it }
        return dump.substring(start, end)
    }
}
