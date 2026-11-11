package app.shareanywhere

import android.util.Log
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.clipboard.CaptureResult
import app.shareanywhere.clipboard.CaptureSource
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android side of the nightly clipboard-cross-client job (scripts/android-clipboard-interop.sh with
 * web/e2e/nightly/clipboard-cross-client.spec.ts): signs in to the account the Web created, adds this device, shows a
 * pairing code (logcat tag SA-CLIP, which the script hands to the Web), receives the key from the Web, decrypts the Web's
 * clipboard item, and syncs one of its own for the Web to decrypt. Skipped unless the script passes `clipboard`.
 */
@RunWith(AndroidJUnit4::class)
class ClipboardInteropTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val args = InstrumentationRegistry.getArguments()

    @Test
    fun pairsWithTheWebAndExchangesEncryptedItems() {
        assumeTrue("clipboard-cross-client only", args.getString("clipboard") == "interop")
        Backend.markWelcomed()
        val email = checkNotNull(args.getString("email"))
        val password = checkNotNull(args.getString("password"))
        val fromWeb = checkNotNull(args.getString("webMarker"))
        val entry = Backend.entry()
        val account = entry.accountManager()
        val runtime = entry.clipboardRuntime()
        ActivityScenario.launch(MainActivity::class.java).use {
            runBlocking {
                withTimeout(30_000) { while (entry.identity().state.value.device == null) delay(200) }
                account.signIn(email, password, addDevice = false)
                withTimeout(10_000) { while (!account.state.value.signedIn) delay(100) }
                assertEquals("the Web holds the key: this device must pair", KeyStatus.Pair, account.addThisDevice(copyHistory = false))

                // AC-6 on this device, as KeyPairScreen does: the payload goes to the Web through logcat.
                val start = account.startPairing()
                Log.i("SA-CLIP", "pair=${start.payload}")
                val ready =
                    withTimeout(240_000) {
                        var s = account.pairingStatus(start.pairingId)
                        while (s.status == "waiting") {
                            delay(2_000)
                            s = account.pairingStatus(start.pairingId)
                        }
                        s
                    }
                assertEquals("ready", ready.status)
                account.finishPairing(start, ready)
                withTimeout(30_000) { while (account.state.value.keys != KeyStatus.Ready) delay(200) }

                // The Web's item decrypts here.
                withTimeout(60_000) {
                    while (runtime.ui.value.snapshot.items.none { it.text == fromWeb }) {
                        runtime.refresh()
                        delay(1_000)
                    }
                }
                // This device's item, for the Web to decrypt.
                // Ordinary words: a single token-like string would be skipped as possibly sensitive (as it should).
                val mine = "Hello from Android at ${System.currentTimeMillis()}"
                val r = runtime.capture(mine, CaptureSource.MANUAL)
                assertTrue("synced: $r", r is CaptureResult.Synced)
                Log.i("SA-CLIP", "marker=$mine")
            }
        }
    }
}
