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
import androidx.test.rule.GrantPermissionRule
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.transfer.engine.PolicyStep
import app.shareanywhere.transfer.engine.RouteKind
import app.shareanywhere.transfer.rtc.RtcTestHooks
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Forced relay on the emulator (docs/phases/PHASE_8_ROUTE_TURN_CLOUD.md, ADR 0029): both ends relay-only through the CI
 * coturn on the host (10.0.2.2 from the emulator), over UDP and over TLS (the CI's self-signed certificate accepted in
 * this debug build), and the received file's SHA-256 matches. The app receives; the other side is a [TestPeer] in this
 * process, which uses the same hooks.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 29) // the default Download/Share Anywhere target uses MediaStore (Android 10+)
class ForcedRelayTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    @After fun resetHooks() = RtcTestHooks.reset()

    @Test fun relayOverUdpCarriesTheTransfer() = relayed(PolicyStep.RELAY_UDP, RouteKind.RELAY_UDP)

    @Test fun relayOverTlsCarriesTheTransfer() = relayed(PolicyStep.RELAY_TLS, RouteKind.RELAY_TLS)

    private fun relayed(step: PolicyStep, expected: RouteKind) {
        Backend.assume()
        Backend.markWelcomed()
        RtcTestHooks.relayOnly = true
        RtcTestHooks.routeStep = step
        RtcTestHooks.insecureTls = true
        RtcTestHooks.turnHost = "10.0.2.2"
        val entry = Backend.entry()
        val (file, sum) = TestPeer.file("relay-${step.wire}-${System.nanoTime()}.bin", 6 * 1024 * 1024 + 7)
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
                    waitForReceiveEnd(view.id, 180_000)
                    compose.waitForTag(ScreenIds.RX_DONE, 30_000)
                    val rx = entry.transferRuntime().existingReceiver(view.id)!!
                    val state = rx.state.value
                    assertEquals(RxPhase.Completed, state.phase)
                    assertEquals("the connection ran over the relay ($step)", expected, state.routeKind)
                    assertEquals("relay", state.route)
                    assertEquals(sum, TestPeer.sha256(peer.context, state.files.single().documentUri!!.toUri()))
                    deleteReceived(view.id)
                    runBlocking { peer.peer.api.close(view.id) }
                }
            }
        }
    }
}
