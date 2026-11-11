package app.shareanywhere.ui.nav

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import app.shareanywhere.R
import app.shareanywhere.config.Flags

/**
 * Screen IDs from `design/claude-design/Android App.dc.html` (docs/UX_SCREEN_MAP.md §12). They are the
 * navigation routes' names and the Compose test tags, so tests and code use the same names as the design.
 */
object ScreenIds {
    const val WELCOME = "welcome"
    const val HOME = "home"
    const val HISTORY = "history"

    /** HI-2 opens as a sheet over `history` (the design's history drawer); its own tag for tests. */
    const val HISTORY_DETAIL = "history-detail"
    const val DEVICES = "devices"
    const val SETTINGS = "settings"
    const val CLIPBOARD = "clipboard"
}

/** Navigation routes. History takes an optional entry to open HI-2 from Transfer home. */
object Routes {
    const val WELCOME = ScreenIds.WELCOME
    const val HOME = ScreenIds.HOME
    const val HISTORY = ScreenIds.HISTORY
    const val HISTORY_ARG = "entry"
    const val HISTORY_PATTERN = "$HISTORY?$HISTORY_ARG={$HISTORY_ARG}"
    const val DEVICES = ScreenIds.DEVICES
    const val SETTINGS = ScreenIds.SETTINGS

    fun history(entryId: String? = null) = if (entryId == null) HISTORY else "$HISTORY?$HISTORY_ARG=$entryId"
}

/** A bottom-navigation tab (PRD §4: Transfer, Clipboard, History, Devices, Settings). */
data class Tab(val route: String, @StringRes val label: Int, @DrawableRes val icon: Int)

object Tabs {
    private val transfer = Tab(Routes.HOME, R.string.android_home, R.drawable.ic_swap_horiz)
    private val clipboard = Tab(ScreenIds.CLIPBOARD, R.string.android_clip, R.drawable.ic_content_paste)
    private val history = Tab(Routes.HISTORY, R.string.android_hist, R.drawable.ic_history)
    private val devices = Tab(Routes.DEVICES, R.string.android_dev, R.drawable.ic_devices)
    private val settings = Tab(Routes.SETTINGS, R.string.android_set, R.drawable.ic_settings)

    /**
     * Tabs in this build. Clipboard is hidden while its flag is off (CLAUDE.md §8b); it has no destination until
     * milestone 6.4, and FlagsTest keeps the flag off until then.
     */
    fun visible(flags: Flags): List<Tab> = listOfNotNull(transfer, clipboard.takeIf { flags.clipboard }, history, devices, settings)
}
