package app.shareanywhere

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.config.AppConfig
import app.shareanywhere.settings.SettingsRepository
import app.shareanywhere.settings.ThemeMode
import app.shareanywhere.ui.i18n.ProvideAppLanguage
import app.shareanywhere.ui.nav.AppNav
import app.shareanywhere.ui.theme.ShareAnywhereTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.launch

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var settings: SettingsRepository

    @Inject lateinit var config: AppConfig

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
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
                            AppNav(
                                welcomed = current.welcomed,
                                flags = config.flags,
                                onWelcomed = { scope.launch { settings.markWelcomed() } }
                            )
                        }
                    }
                }
            }
        }
    }
}
