package app.shareanywhere.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import app.shareanywhere.history.Retention
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

enum class ThemeMode(val stored: String) { SYSTEM("system"), LIGHT("light"), DARK("dark") }

/** App language: follow the system, or English / Vietnamese (the two catalogs). */
enum class AppLanguage(val stored: String, val tag: String?) { SYSTEM("system", null), EN("en", "en"), VI("vi", "vi") }

/** Per-device preferences. None of them is a secret; the refresh secret lives in KeystoreSecretStore. */
data class AppSettings(
    /** Welcome is shown once, on first launch (docs/UX_SCREEN_MAP.md ON-1). */
    val welcomed: Boolean = false,
    val theme: ThemeMode = ThemeMode.SYSTEM,
    val language: AppLanguage = AppLanguage.SYSTEM,
    /** Keep screen on during transfers, default on (PRD §5.10, docs/ARCHITECTURE.md §7.1). */
    val keepScreenOn: Boolean = true,
    val retention: Retention = Retention.DEFAULT,
    /** Clipboard Sync: capture what is copied while the app is open (CB-4, this device only; default on). */
    val clipboardAuto: Boolean = true
)

class SettingsRepository(private val store: DataStore<Preferences>) {
    val settings: Flow<AppSettings> =
        store.data
            .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
            .map { p ->
                AppSettings(
                    welcomed = p[WELCOMED] ?: false,
                    theme = ThemeMode.entries.firstOrNull { it.stored == p[THEME] } ?: ThemeMode.SYSTEM,
                    language = AppLanguage.entries.firstOrNull { it.stored == p[LANGUAGE] } ?: AppLanguage.SYSTEM,
                    keepScreenOn = p[KEEP_SCREEN_ON] ?: true,
                    retention = Retention.fromStored(p[RETENTION]),
                    clipboardAuto = p[CLIPBOARD_AUTO] ?: true
                )
            }

    suspend fun markWelcomed() = store.edit { it[WELCOMED] = true }

    suspend fun setTheme(mode: ThemeMode) = store.edit { it[THEME] = mode.stored }

    suspend fun setLanguage(language: AppLanguage) = store.edit { it[LANGUAGE] = language.stored }

    suspend fun setKeepScreenOn(on: Boolean) = store.edit { it[KEEP_SCREEN_ON] = on }

    suspend fun setRetention(retention: Retention) = store.edit { it[RETENTION] = retention.stored }

    suspend fun setClipboardAuto(on: Boolean) = store.edit { it[CLIPBOARD_AUTO] = on }

    companion object {
        const val FILE = "settings"
        private val WELCOMED = booleanPreferencesKey("welcomed")
        private val THEME = stringPreferencesKey("theme")
        private val LANGUAGE = stringPreferencesKey("language")
        private val KEEP_SCREEN_ON = booleanPreferencesKey("keep_screen_on")
        private val RETENTION = stringPreferencesKey("history_retention")
        private val CLIPBOARD_AUTO = booleanPreferencesKey("clipboard_auto")
    }
}
