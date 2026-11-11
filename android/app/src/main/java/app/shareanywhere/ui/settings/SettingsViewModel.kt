package app.shareanywhere.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.config.AppConfig
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.history.Retention
import app.shareanywhere.settings.AppLanguage
import app.shareanywhere.settings.AppSettings
import app.shareanywhere.settings.SettingsRepository
import app.shareanywhere.settings.ThemeMode
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

enum class SettingsEvent { Cleared, ClearFailed }

@HiltViewModel
class SettingsViewModel
@Inject
constructor(
    private val settings: SettingsRepository,
    private val history: HistoryRepository,
    val config: AppConfig
) : ViewModel() {
    /** Null until the stored settings are read, so the screen never flashes defaults. */
    val state: StateFlow<AppSettings?> =
        settings.settings.map<AppSettings, AppSettings?> { it }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /** Whether local History has entries (Clear history is offered only then). */
    val hasHistory: StateFlow<Boolean> =
        history.observeAll().map { it.isNotEmpty() }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    private val _events = MutableStateFlow<SettingsEvent?>(null)
    val events: StateFlow<SettingsEvent?> = _events.asStateFlow()

    fun setTheme(mode: ThemeMode) = launch { settings.setTheme(mode) }

    fun setLanguage(language: AppLanguage) = launch { settings.setLanguage(language) }

    fun setKeepScreenOn(on: Boolean) = launch { settings.setKeepScreenOn(on) }

    /** Stores the retention and applies it at once, as the Web does on its next History load. */
    fun setRetention(retention: Retention) = launch {
        settings.setRetention(retention)
        history.sweep(retention)
    }

    fun clearHistory() = viewModelScope.launch {
        _events.value =
            try {
                history.clear()
                SettingsEvent.Cleared
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                SettingsEvent.ClearFailed
            }
    }

    fun eventShown() {
        _events.value = null
    }

    private fun launch(block: suspend () -> Unit) {
        viewModelScope.launch { block() }
    }
}
