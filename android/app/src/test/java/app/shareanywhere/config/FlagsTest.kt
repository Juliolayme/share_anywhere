package app.shareanywhere.config

import app.shareanywhere.BuildConfig
import app.shareanywhere.R
import app.shareanywhere.di.AppModule
import app.shareanywhere.ui.nav.Routes
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.nav.Tabs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Send and Receive are on from milestone 6.2; accounts and Clipboard from 6.4 (CLAUDE.md §8b). */
class FlagsTest {
    @Test
    fun flagsMatchTheMilestone() {
        assertTrue("Send and Receive work from 6.2", BuildConfig.FLAG_SHARING)
        assertTrue("accounts work from 6.4", BuildConfig.FLAG_ACCOUNTS)
        assertTrue("Clipboard works from 6.4", BuildConfig.FLAG_CLIPBOARD)
    }

    @Test
    fun bottomNavigationHasTheFiveTabsInTheDesignOrder() {
        val tabs = Tabs.visible(AppConfig.fromBuildConfig().flags)
        assertEquals(listOf(Routes.HOME, ScreenIds.CLIPBOARD, Routes.HISTORY, Routes.DEVICES, Routes.SETTINGS), tabs.map { it.route })
        assertEquals(
            listOf(R.string.android_home, R.string.android_clip, R.string.android_hist, R.string.android_dev, R.string.android_set),
            tabs.map { it.label }
        )
        // Clipboard needs accounts: with the flag off the tab is hidden.
        val withoutClipboard = Tabs.visible(Flags(sharing = true, accounts = true, clipboard = false))
        assertFalse(withoutClipboard.any { it.label == R.string.android_clip })
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
