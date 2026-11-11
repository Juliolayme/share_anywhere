package app.shareanywhere

import android.Manifest
import android.content.Intent
import android.util.Log
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.notify.Notifier
import app.shareanywhere.transfer.OutgoingFile
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android side of the nightly android-web-interop job (scripts/android-interop.sh with
 * web/e2e/nightly/android-interop.spec.ts). Skipped unless the script passes `interop`; the code and hashes come
 * from instrumentation arguments (Web → Android) or go to logcat tag SA-INTEROP (Android → Web).
 */
@RunWith(AndroidJUnit4::class)
class InteropTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (android.os.Build.VERSION.SDK_INT >=
            33
        ) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    private val args = InstrumentationRegistry.getArguments()

    @Test
    fun receivesFromTheWeb() {
        assumeTrue("android-web-interop only", args.getString("interop") == "receive")
        Backend.markWelcomed()
        val code = checkNotNull(args.getString("code"))
        val sha = checkNotNull(args.getString("sha256"))
        val id = checkNotNull(args.getString("session"))
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.dumpOnFailure {
                compose.waitForTag(ScreenIds.HOME)
                compose.onNodeWithTag("home.receive").performClick()
                compose.onNodeWithTag("receive.tab-code").performClick()
                compose.waitForTag(ScreenIds.RECEIVE_CODE)
                compose.onNodeWithTag("receive.code-input").performTextInput(code)
                compose.onNodeWithTag("receive.continue").performClick()
                compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
                compose.onNodeWithTag("preview.receive").tap()
                compose.waitForTag("rx.start", 30_000)
                compose.onNodeWithTag("rx.start").tap()
                waitForReceiveEnd(id, 14 * 60_000L)
                compose.waitForTag(ScreenIds.RX_DONE, 30_000)
                val state = Backend.entry().transferRuntime().existingReceiver(id)!!.state.value
                // On failure, say why (the receiver's error and each file's state) for the nightly log.
                assertEquals(
                    "receiver error=${state.error} files=${state.files.map {
                        "${it.verified}/${it.size} done=${it.done} failed=${it.failed}"
                    }}",
                    RxPhase.Completed,
                    state.phase
                )
                assertEquals(sha, TestPeer.sha256(ApplicationProvider.getApplicationContext(), state.files.single().documentUri!!.toUri()))
            }
        }
    }

    @Test
    fun sendsToTheWeb() {
        assumeTrue("android-web-interop only", args.getString("interop") == "send")
        Backend.markWelcomed()
        val entry = Backend.entry()
        val (file, sum) = TestPeer.file("android-to-web-64M.bin", 64 * 1024 * 1024)
        val view =
            runBlocking { entry.sessionsApi().create(listOf(FileInput(file.name, file.length(), "application/octet-stream")), false) }
        runBlocking {
            val row =
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
            entry.outgoingFiles().insertAll(listOf(row))
        }
        // The script reads these lines and starts the Web receiver.
        Log.i("SA-INTEROP", "code=${view.code} sha256=$sum name=${file.name}")
        val intent =
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .setAction(Notifier.ACTION_OPEN_SESSION)
                .putExtra(Notifier.EXTRA_SESSION_ID, view.id)
        ActivityScenario.launch<MainActivity>(intent).use {
            compose.dumpOnFailure {
                // The transfer is watched through the runtime (no UI polling while bytes move); the dashboard is checked after.
                waitForSendEnd(view.id, 19 * 60_000L)
                compose.waitForTag("session.dashboard", 30_000)
                compose.onNodeWithTag("session.dashboard").tap()
                compose.waitForTag(ScreenIds.DASHBOARD_DONE, 30_000)
            }
        }
    }
}
