package app.shareanywhere.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.identity.IdentityManager
import app.shareanywhere.identity.IdentityState
import app.shareanywhere.ui.history.HistoryLoad
import app.shareanywhere.ui.history.load
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

data class HomeUi(
    val identity: IdentityState = IdentityState(),
    val history: HistoryLoad = HistoryLoad.Loading,
    val now: Long = System.currentTimeMillis()
)

@HiltViewModel
class HomeViewModel
@Inject
constructor(private val identity: IdentityManager, history: HistoryRepository) : ViewModel() {
    val ui: StateFlow<HomeUi> =
        combine(identity.state, history.load()) { id, h -> HomeUi(id, h, System.currentTimeMillis()) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeUi(identity.state.value))

    fun retryIdentity() = identity.start()

    fun dismissReplaced() = identity.dismissReplaced()
}
