package app.shareanywhere

import android.app.Application
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.shareanywhere.di.AppEntryPoint
import app.shareanywhere.ui.nav.ScreenIds
import dagger.hilt.android.EntryPointAccessors
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Anonymous identity against the real backend (CI stack at 10.0.2.2, `-Pbackend`): created in the background with
 * no sign-in, shown on Devices, and usable for an authenticated call (rename). Runs only when the instrumentation
 * argument `backend` is set, which android-emulator.yml always does.
 */
@RunWith(AndroidJUnit4::class)
class IdentityBackendTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun guestIdentityIsCreatedInTheBackgroundAndCanRenameTheDevice() {
        assumeTrue("needs -Pbackend", InstrumentationRegistry.getArguments().getString("backend") != null)
        val app = ApplicationProvider.getApplicationContext<Application>()
        runBlocking { EntryPointAccessors.fromApplication(app, AppEntryPoint::class.java).settingsRepository().markWelcomed() }
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitForTag(ScreenIds.HOME)
            compose.onNodeWithTag("nav.${ScreenIds.DEVICES}").performClick()
            compose.waitForTag("devices.name", timeoutMs = 30_000)
            compose.waitForText("Android")

            compose.onNodeWithTag("devices.rename").performClick()
            compose.waitForTag("devices.rename.field")
            compose.onNodeWithTag("devices.rename.field").performTextReplacement("CI emulator")
            compose.onNodeWithTag("devices.rename.save").performClick()
            // The dialog closes only when the server accepted the new name.
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("devices.rename.field").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithTag("devices.name").assertTextEquals("CI emulator")
        }
    }
}
