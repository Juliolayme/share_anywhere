package app.shareanywhere

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import app.shareanywhere.clipboard.ClipboardRuntime
import app.shareanywhere.config.AppConfig
import app.shareanywhere.notify.Notifier
import app.shareanywhere.settings.SettingsRepository
import app.shareanywhere.settings.ThemeMode
import app.shareanywhere.sharing.linkTokenFrom
import app.shareanywhere.ui.i18n.ProvideAppLanguage
import app.shareanywhere.ui.keepawake.KeepAwakeController
import app.shareanywhere.ui.keepawake.KeepScreenOnEffect
import app.shareanywhere.ui.keepawake.LocalKeepAwake
import app.shareanywhere.ui.nav.AppNav
import app.shareanywhere.ui.nav.Routes
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.ShareAnywhereTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var settings: SettingsRepository

    @Inject lateinit var config: AppConfig

    @Inject lateinit var keepAwake: KeepAwakeController

    @Inject lateinit var clipboard: dagger.Lazy<app.shareanywhere.clipboard.ClipboardRuntime>

    /** Incremented by the clipboard notification's Sync action: the Clipboard tab runs one Sync Clipboard. */
    private val clipboardSync = MutableStateFlow(0)

    /** A route opened from outside: an App Link (`<public origin>/j/<token>`) or a session notification. */
    private val pendingRoute = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) pendingRoute.value = routeFor(intent)
        // Clipboard capture follows this Activity's lifecycle (registered only while resumed, PRD §7.3).
        if (config.flags.clipboard) clipboard.get().attach(this)
        lifecycleScope.launch { settings.settings.collect { keepAwake.setSetting(it.keepScreenOn) } }
        setContent {
            val pending by pendingRoute.collectAsStateWithLifecycle()
            val clipSync by clipboardSync.collectAsStateWithLifecycle()
            val s by settings.settings.collectAsStateWithLifecycle(initialValue = null)
            val scope = rememberCoroutineScope()
            val current = s
            val dark =
                when (current?.theme) {
                    ThemeMode.LIGHT -> false
                    ThemeMode.DARK -> true
                    else -> isSystemInDarkTheme()
                }
            ShareAnywhereTheme(dark = dark) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    // Until the stored settings are read the window background shows, so Welcome never
                    // flashes for a returning user.
                    if (current != null) {
                        ProvideAppLanguage(current.language) {
                            CompositionLocalProvider(LocalKeepAwake provides keepAwake) {
                                KeepScreenOnEffect(keepAwake)
                                AppNav(
                                    welcomed = current.welcomed,
                                    flags = config.flags,
                                    onWelcomed = { scope.launch { settings.markWelcomed() } },
                                    onTurnKeepScreenOn = { scope.launch { settings.setKeepScreenOn(true) } },
                                    pendingRoute = pending,
                                    onPendingRouteHandled = { pendingRoute.value = null },
                                    clipboardSync = clipSync
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        routeFor(intent)?.let { pendingRoute.value = it }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (config.flags.clipboard) clipboard.get().onWindowFocus(hasFocus)
    }

    /** Maps an App Link or a notification tap to a navigation route; anything else opens the app normally. */
    private fun routeFor(intent: Intent?): String? {
        if (intent == null) return null
        if (config.flags.clipboard && intent.action in setOf(ClipboardRuntime.ACTION_OPEN, ClipboardRuntime.ACTION_SYNC)) {
            // The notification action opens the Activity; the read happens here, in front, as Android requires.
            if (intent.action == ClipboardRuntime.ACTION_SYNC) clipboardSync.value += 1
            return ScreenIds.CLIPBOARD
        }
        if (!config.flags.sharing) return null
        if (intent.action == Notifier.ACTION_OPEN_SESSION) {
            val id = intent.getStringExtra(Notifier.EXTRA_SESSION_ID) ?: return null
            return if (UUID.matches(id)) Routes.session(id) else null
        }
        if (intent.action == Intent.ACTION_VIEW) {
            val token = intent.dataString?.let { linkTokenFrom(it, config.publicUrl) } ?: return null
            return Routes.joinLink(token)
        }
        return null
    }

    private companion object {
        val UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    }
}
