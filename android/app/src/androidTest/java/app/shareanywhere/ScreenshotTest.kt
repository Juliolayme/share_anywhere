package app.shareanywhere

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
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
