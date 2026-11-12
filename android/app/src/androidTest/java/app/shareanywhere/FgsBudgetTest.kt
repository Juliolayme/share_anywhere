package app.shareanywhere

import android.Manifest
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.transfer.TransferService
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android 15 dataSync time budget (PRD §2 long transfers, docs/ADR/0020-android-background-transfers.md), simulated with a
 * short `data_sync_fgs_timeout_duration`: when the system ends the foreground service, the transfer pauses with its
 * progress kept, the service stops, and Resume finishes the file with a matching SHA-256. Nightly `android-matrix`
 * (API 35); skipped below API 35.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 35)
class FgsBudgetTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @After
    fun restore() {
        device.executeShellCommand("device_config delete activity_manager data_sync_fgs_timeout_duration")
        device.executeShellCommand("device_config set_sync_disabled_for_tests none")
    }

    @Test
    fun theBudgetEndingPausesTheTransferWhichResumes() {
        Backend.assume()
        Backend.markWelcomed()
        // A short dataSync budget (Android's documented test knob). The app targets API 35, so the limit already applies;
        // `am compat enable` is not used because it restarts the app's process, which hosts this test.
        // Flag sync would otherwise put the server value back (seen as `get` returning null right after `put`).
        device.executeShellCommand("device_config set_sync_disabled_for_tests persistent")
        device.executeShellCommand("device_config put activity_manager data_sync_fgs_timeout_duration 2000")
        assertEquals(
            "the shortened budget is in effect",
            "2000",
            device.executeShellCommand("device_config get activity_manager data_sync_fgs_timeout_duration").trim()
        )
        val entry = Backend.entry()
        val (file, sum) = TestPeer.file("budget-${System.nanoTime()}.bin", 512 * 1024 * 1024)
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
                    compose.waitForTag("rx.start", 30_000)
                    compose.onNodeWithTag("rx.start").tap()
                    val rx = { entry.transferRuntime().existingReceiver(view.id)!! }
                    compose.waitUntil(60_000) {
                        entry.transferRuntime().existingReceiver(view.id)?.state?.value?.phase ==
                            RxPhase.Transferring
                    }

                    // The budget only runs while the app is in the background (being in front resets it).
                    try {
                        compose.waitUntil(15_000) { TransferService.running }
                    } catch (e: androidx.compose.ui.test.ComposeTimeoutException) {
                        android.util.Log.e("SA-TEST", "service not running; activity=${entry.transferRuntime().activity.value}")
                        throw e
                    }
                    android.util.Log.i(
                        "SA-TEST",
                        "budget=" + device.executeShellCommand("device_config get activity_manager data_sync_fgs_timeout_duration").trim() +
                            "\n" + device.executeShellCommand("dumpsys activity services app.shareanywhere").take(3000)
                    )
                    device.pressHome()
                    val paused = runBlocking {
                        withTimeout(60_000) {
                            rx().state.first {
                                it.phase == RxPhase.Paused ||
                                    it.phase == RxPhase.Completed
                            }
                        }
                    }
                    assertEquals("paused by the budget before the end", RxPhase.Paused, paused.phase)
                    compose.waitUntil(20_000) { !TransferService.running }
                    assertFalse(TransferService.running)
                    device.openNotification()
                    assertTrue(
                        "the budget notification asks to reopen the app",
                        device.wait(Until.hasObject(By.text(Backend.entryString(R.string.product_fgs_budget_h))), 15_000)
                    )
                    device.pressBack()

                    // Back in the app with the budget restored, Resume finishes the file from where it stopped.
                    device.executeShellCommand("device_config delete activity_manager data_sync_fgs_timeout_duration")
                    ActivityScenario.launch(MainActivity::class.java)
                    rx().resume()
                    val done = runBlocking {
                        withTimeout(300_000) {
                            rx().state.first {
                                it.phase == RxPhase.Completed ||
                                    it.phase == RxPhase.Failed
                            }
                        }
                    }
                    assertEquals(RxPhase.Completed, done.phase)
                    assertEquals(sum, TestPeer.sha256(peer.context, done.files.single().documentUri!!.toUri()))
                    deleteReceived(view.id)
                    runBlocking { runCatching { peer.peer.api.close(view.id) } }
                }
            }
        }
    }
}
