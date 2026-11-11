package app.shareanywhere.ui.history

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryFilter
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.history.filterHistory
import app.shareanywhere.history.historyPeers
import app.shareanywhere.settings.SettingsRepository
import app.shareanywhere.ui.nav.Routes
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Local History as the screens see it: loading, failed, or loaded entries (newest first). */
sealed interface HistoryLoad {
    data object Loading : HistoryLoad

    data object Failed : HistoryLoad

    data class Loaded(val entries: List<HistoryEntry>) : HistoryLoad
}

/** Observes local History, mapping a database failure to [HistoryLoad.Failed]. */
fun HistoryRepository.load() = observeAll()
    .map<List<HistoryEntry>, HistoryLoad> { HistoryLoad.Loaded(it) }
    .catch { emit(HistoryLoad.Failed) }

data class HistoryUi(
    val load: HistoryLoad = HistoryLoad.Loading,
    val filter: HistoryFilter = HistoryFilter(),
    val visible: List<HistoryEntry> = emptyList(),
    val peers: List<String> = emptyList(),
    val selected: HistoryEntry? = null,
    val now: Long = System.currentTimeMillis()
)

/** One-shot outcomes the screen reports in a snackbar. */
enum class HistoryEvent { Removed, RemoveFailed, Cleared, ClearFailed }

@HiltViewModel
class HistoryViewModel
@Inject
constructor(
    private val repository: HistoryRepository,
    private val settings: SettingsRepository,
    private val saved: SavedStateHandle
) : ViewModel() {
    private val filter = MutableStateFlow(HistoryFilter())
    private val selectedId = saved.getStateFlow<String?>(Routes.HISTORY_ARG, null)
    private val _events = MutableStateFlow<HistoryEvent?>(null)
    val events: StateFlow<HistoryEvent?> = _events.asStateFlow()

    val ui: StateFlow<HistoryUi> =
        combine(repository.load(), filter, selectedId) { load, f, sel ->
            val now = System.currentTimeMillis()
            val entries = (load as? HistoryLoad.Loaded)?.entries.orEmpty()
            HistoryUi(
                load = load,
                filter = f,
                visible = filterHistory(entries, f, now),
                peers = historyPeers(entries),
                selected = sel?.let { id -> entries.firstOrNull { it.id == id } },
                now = now
            )
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HistoryUi())

    init {
        viewModelScope.launch { runCatching { repository.sweep(settings.settings.first().retention) } }
    }

    fun setFilter(f: HistoryFilter) {
        filter.value = f
    }

    fun open(id: String?) {
        saved[Routes.HISTORY_ARG] = id
    }

    fun remove(id: String) {
        viewModelScope.launch {
            _events.value =
                try {
                    repository.remove(id)
                    open(null)
                    HistoryEvent.Removed
                } catch (e: Exception) {
                    HistoryEvent.RemoveFailed
                }
        }
    }

    fun clear() {
        viewModelScope.launch {
            _events.value =
                try {
                    repository.clear()
                    HistoryEvent.Cleared
                } catch (e: Exception) {
                    HistoryEvent.ClearFailed
                }
        }
    }

    fun eventShown() {
        _events.value = null
    }
}
