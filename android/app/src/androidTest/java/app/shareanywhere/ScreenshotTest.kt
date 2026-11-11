package app.shareanywhere

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.UiDevice
import app.shareanywhere.settings.ThemeMode
import app.shareanywhere.ui.nav.ScreenIds
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Screenshots of the screens a fresh guest install reaches, in light, dark and at font scale 1.3
 * (docs/phases/PHASE_6_ANDROID.md "Compose screenshot tests"). Each PNG is written through TestStorage and lands in
 * `app/build/outputs/connected_android_test_additional_output/` (uploaded with the emulator reports) for the phase
 * report; the run also fails if a screen does not render.
 */
@RunWith(AndroidJUnit4::class)
class ScreenshotTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @After
    fun restore() {
        device.executeShellCommand("settings put system font_scale 1.0")
    }

    @Test
    fun light() = capture("light", ThemeMode.LIGHT, 1.0f)

    @Test
    fun dark() = capture("dark", ThemeMode.DARK, 1.0f)

    @Test
    fun largeFont() = capture("light-font130", ThemeMode.LIGHT, 1.3f)

    @Test
    fun lightSignedInAndSession() = captureWithBackend("light", ThemeMode.LIGHT, 1.0f)

    @Test
    fun darkSignedInAndSession() = captureWithBackend("dark", ThemeMode.DARK, 1.0f)

    @Test
    fun largeFontSignedInAndSession() = captureWithBackend("light-font130", ThemeMode.LIGHT, 1.3f)

    /**
     * Screens that need the CI backend: the sender's session and its expired state, the receiver's preview and save
     * screens, and the account flow (trust, key setup, checklist) with the signed-in Clipboard, Clipboard settings,
     * Devices and Settings. The key-setup phrase screen sets FLAG_SECURE, so its capture may come out blank by design.
     */
    private fun captureWithBackend(variant: String, theme: ThemeMode, fontScale: Float) {
        Backend.assume()
        Backend.markWelcomed()
        device.executeShellCommand("settings put system font_scale $fontScale")
        val entry = Backend.entry()
        runBlocking { entry.settingsRepository().setTheme(theme) }
        val mine =
            runBlocking { entry.sessionsApi().create(listOf(app.shareanywhere.data.api.FileInput("notes.txt", 12, "text/plain")), false) }
        val intent = android.content.Intent(androidx.test.core.app.ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .setAction(app.shareanywhere.notify.Notifier.ACTION_OPEN_SESSION)
            .putExtra(app.shareanywhere.notify.Notifier.EXTRA_SESSION_ID, mine.id)
        val peer = Backend.Peer.create()
        val theirs =
            runBlocking { peer.api.create(listOf(app.shareanywhere.data.api.FileInput("photo.jpg", 2_400_000, "image/jpeg")), false) }
        ActivityScenario.launch<MainActivity>(intent).use {
            compose.dumpOnFailure {
                compose.waitForTag(ScreenIds.SESSION, 30_000)
                save(variant, ScreenIds.SESSION)
                runBlocking { entry.sessionsApi().close(mine.id) }

                // Account flow from Settings, then the signed-in tabs.
                device.pressBack()
                compose.waitForTag(ScreenIds.HOME, 15_000)
                compose.onNodeWithTag("nav.${ScreenIds.SETTINGS}").performClick()
                compose.waitForTag("settings.create", 15_000)
                compose.onNodeWithTag("settings.create").tap()
                compose.waitForTag(ScreenIds.SIGNUP)
                compose.onNodeWithTag("signup.email").performTextInput("shot-${java.util.UUID.randomUUID().toString().take(8)}@example.com")
                compose.onNodeWithTag("signup.password").performTextInput("Sa-shot-${java.util.UUID.randomUUID().toString().take(6)}-pw!")
                compose.onNodeWithTag("signup.submit").tap()
                compose.waitForTag(ScreenIds.TRUST, 30_000)
                save(variant, ScreenIds.TRUST)
                compose.onNodeWithTag("trust.continue").tap()
                compose.waitForTag("key-setup.words", 120_000)
                save(variant, ScreenIds.KEY_SETUP)
                compose.onNodeWithTag("key-setup.saved").tap()
                compose.onNodeWithTag("key-setup.continue").tap()
                compose.waitForTag(ScreenIds.CHECKLIST, 60_000)
                save(variant, ScreenIds.CHECKLIST)
                compose.onNodeWithTag("checklist.clipboard").tap()
                compose.waitForTag("clipboard.home", 60_000)
                save(variant, "${ScreenIds.CLIPBOARD}-signed-in")
                compose.onNodeWithTag("clipboard.home").performScrollToNode(hasTestTag("clipboard.settings-link"))
                compose.onNodeWithTag("clipboard.settings-link").tap()
                compose.waitForTag(ScreenIds.CLIPBOARD_SETTINGS)
                save(variant, ScreenIds.CLIPBOARD_SETTINGS)
                device.pressBack()
                for (route in listOf(ScreenIds.DEVICES, ScreenIds.SETTINGS)) {
                    compose.onNodeWithTag("nav.$route").performClick()
                    compose.waitForTag(route)
                    save(variant, "$route-signed-in")
                }

                // Receive: preview and the save screen.
                compose.onNodeWithTag("nav.${ScreenIds.HOME}").performClick()
                compose.waitForTag(ScreenIds.HOME, 15_000)
                compose.onNodeWithTag("home.receive").performClick()
                compose.onNodeWithTag("receive.tab-code").performClick()
                compose.waitForTag(ScreenIds.RECEIVE_CODE)
                compose.onNodeWithTag("receive.code-input").performTextInput(theirs.code!!)
                compose.onNodeWithTag("receive.continue").performClick()
                compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
                save(variant, ScreenIds.RX_PREVIEW)
                compose.onNodeWithTag("preview.receive").tap()
                compose.waitForTag("rx.start", 30_000)
                save(variant, ScreenIds.RX_SAVE)
                runBlocking { runCatching { peer.api.close(theirs.id) } }
            }
        }
    }

    private fun save(variant: String, name: String) {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        TestStorage().openOutputFile("screenshots/$variant/$name.png").use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun tab(route: String, variant: String) {
        compose.onNodeWithTag("nav.$route").performClick()
        compose.waitForTag(route)
        save(variant, route)
    }

    private fun capture(variant: String, theme: ThemeMode, fontScale: Float) {
        device.executeShellCommand("settings put system font_scale $fontScale")
        runBlocking { Backend.entry().settingsRepository().setTheme(theme) }
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.dumpOnFailure {
                compose.waitForTag(ScreenIds.WELCOME)
                save(variant, ScreenIds.WELCOME)
                compose.onNodeWithTag("welcome.start").performClick()
                compose.waitForTag(ScreenIds.HOME)
                save(variant, ScreenIds.HOME)
                for (route in listOf(ScreenIds.CLIPBOARD, ScreenIds.HISTORY, ScreenIds.DEVICES, ScreenIds.SETTINGS)) tab(route, variant)

                // Account screens, reached from Settings (an account CTA).
                compose.onNodeWithTag("settings.signin").tap()
                compose.waitForTag(ScreenIds.SIGNIN)
                save(variant, ScreenIds.SIGNIN)
                compose.onNodeWithTag("signin.forgot").tap()
                compose.waitForTag(ScreenIds.FORGOT)
                save(variant, ScreenIds.FORGOT)
                device.pressBack()
                compose.waitForTag(ScreenIds.SIGNIN)
                compose.onNodeWithTag("signin.create").tap()
                compose.waitForTag(ScreenIds.SIGNUP)
                save(variant, ScreenIds.SIGNUP)
                device.pressBack()

                // Receive: the code entry tab (the camera tab needs a camera).
                compose.onNodeWithTag("nav.${ScreenIds.HOME}").performClick()
                compose.waitForTag(ScreenIds.HOME)
                compose.onNodeWithTag("home.receive").performClick()
                compose.onNodeWithTag("receive.tab-code").performClick()
                compose.waitForTag(ScreenIds.RECEIVE_CODE)
                save(variant, ScreenIds.RECEIVE_CODE)
            }
        }
    }
}
