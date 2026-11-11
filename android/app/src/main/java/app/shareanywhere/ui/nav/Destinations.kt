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

    // Send (TR-2…TR-5) and Receive (RX-1…RX-7), milestone 6.2.
    const val SEND = "send"
    const val SESSION = "session"
    const val SESSION_EXPIRED = "session-expired"
    const val RECEIVE = "receive"
    const val RECEIVE_CODE = "receive-code"
    const val RX_PREVIEW = "rx-preview"
    const val RX_WAIT = "rx-wait"
    const val RX_SAVE = "rx-save"
    const val RX_PROGRESS = "rx-progress"
    const val DASHBOARD = "dashboard"
    const val DASHBOARD_DONE = "dashboard-done"
    const val DASHBOARD_PARTIAL = "dashboard-partial"
    const val RX_DONE = "rx-done"
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

    const val SEND = ScreenIds.SEND
    const val ID_ARG = "id"
    const val SESSION_PATTERN = "${ScreenIds.SESSION}/{$ID_ARG}"
    const val RECEIVE = ScreenIds.RECEIVE
    const val RX_PREVIEW_PATTERN = "${ScreenIds.RX_PREVIEW}/{$ID_ARG}"
    const val RX_SESSION_PATTERN = "${ScreenIds.RX_WAIT}/{$ID_ARG}"

    /** App Link target: `<public origin>/j/<token>` opens RX-3 (resolve) then RX-4 (preview). */
    const val TOKEN_ARG = "token"
    const val JOIN_LINK_PATTERN = "join/{$TOKEN_ARG}"

    const val DASHBOARD_PATTERN = "${ScreenIds.DASHBOARD}/{$ID_ARG}"

    fun session(id: String) = "${ScreenIds.SESSION}/$id"

    fun dashboard(id: String) = "${ScreenIds.DASHBOARD}/$id"

    fun rxPreview(sessionId: String) = "${ScreenIds.RX_PREVIEW}/$sessionId"

    fun rxSession(sessionId: String) = "${ScreenIds.RX_WAIT}/$sessionId"

    fun joinLink(token: String) = "join/$token"

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
