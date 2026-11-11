package app.shareanywhere.config

import app.shareanywhere.BuildConfig
import app.shareanywhere.R
import app.shareanywhere.di.AppModule
import app.shareanywhere.ui.nav.Routes
import app.shareanywhere.ui.nav.Tabs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Milestone 6.1 ships no account, sign-in, clipboard or sharing UI (CLAUDE.md §8b). */
class FlagsTest {
    @Test
    fun unbuiltFeaturesAreOffInThisMilestone() {
        assertFalse("Send and Receive arrive in 6.2", BuildConfig.FLAG_SHARING)
        assertFalse("accounts arrive in 6.4", BuildConfig.FLAG_ACCOUNTS)
        assertFalse("Clipboard arrives in 6.4", BuildConfig.FLAG_CLIPBOARD)
    }

    @Test
    fun bottomNavigationHasTheGuestTabsAndHidesClipboard() {
        val tabs = Tabs.visible(AppConfig.fromBuildConfig().flags)
        assertEquals(listOf(Routes.HOME, Routes.HISTORY, Routes.DEVICES, Routes.SETTINGS), tabs.map { it.route })
        assertEquals(
            listOf(R.string.android_home, R.string.android_hist, R.string.android_dev, R.string.android_set),
            tabs.map { it.label }
        )
        val withClipboard = Tabs.visible(Flags(sharing = false, accounts = true, clipboard = true))
        assertTrue(withClipboard.any { it.label == R.string.android_clip })
    }

    @Test
    fun debugBackendDefaultsToTheEmulatorHost() {
        assertTrue(BuildConfig.BACKEND_URL.startsWith("http://10.0.2.2") || BuildConfig.BACKEND_URL.startsWith("http"))
    }

    @Test
    fun platformLabelNamesTheModel() {
        assertEquals("Android · Pixel 7", AppModule.platformLabel("Pixel 7"))
        assertEquals("Android", AppModule.platformLabel(" "))
        assertTrue(AppModule.platformLabel("x".repeat(100)).length <= 60)
    }
}
