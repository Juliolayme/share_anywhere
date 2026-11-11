package app.shareanywhere.ui.receive

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.Decision
import app.shareanywhere.data.api.SessionView
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.data.ws.SocketEvent
import app.shareanywhere.identity.IdentityManager
import app.shareanywhere.ui.nav.Routes
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** How this receiver's part in the session ended (RX-5 declined, RX-7 outcomes). */
enum class Outcome { Removed, Blocked, Rejected, Left, Closed, Ended }

data class ReceiveSessionUi(
    val view: SessionView? = null,
    val gone: Boolean = false,
    val failed: Boolean = false,
    val leaving: Boolean = false,
    val leaveFailed: Boolean = false
) {
    val outcome: Outcome?
        get() {
            if (gone) return Outcome.Ended
            val v = view ?: return null
            when (v.me?.status) {
                "REMOVED" -> return Outcome.Removed
                "BLOCKED" -> return Outcome.Blocked
                "REJECTED" -> return Outcome.Rejected
                "LEFT" -> return Outcome.Left
            }
            if (v.status == "CLOSED") return Outcome.Closed
            if (v.status == "COMPLETED" || v.status == "PARTIALLY_COMPLETED") return null
            if (v.status != "WAITING" && v.status != "ACTIVE") return Outcome.Ended
            return null
        }
    val waiting: Boolean get() = outcome == null && view?.me?.status == "REQUESTED"
    val joined: Boolean get() = outcome == null && view?.me?.status == "JOINED"
}

/** RX-5 waiting for approval and the joined receiver's session, following live events; Leave and Cancel request. */
@HiltViewModel
class ReceiveSessionViewModel @Inject constructor(
    saved: SavedStateHandle,
    private val api: SessionsApi,
    private val socket: SessionSocket,
    identity: IdentityManager
) : ViewModel() {
    val sessionId: String = checkNotNull(saved[Routes.ID_ARG])
    private val _ui = MutableStateFlow(ReceiveSessionUi())
    val ui: StateFlow<ReceiveSessionUi> = _ui.asStateFlow()
    val deviceName = identity.state.map { it.device?.displayName }
    private val _left = Channel<Unit>(Channel.BUFFERED)
    val left = _left.receiveAsFlow()
    private val lock = Mutex()

    init {
        load()
        viewModelScope.launch {
            socket.subscribe().collect { e -> if (e.type == SocketEvent.OPEN || e.sessionId == sessionId) load() }
        }
    }

    fun load() {
        viewModelScope.launch {
            lock.withLock {
                try {
                    val v = api.get(sessionId)
                    _ui.update { it.copy(view = v, failed = false) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (e is ApiException && e.status == 404) _ui.update { it.copy(gone = true) } else _ui.update { it.copy(failed = true) }
                }
            }
        }
    }

    fun leave() {
        val me = _ui.value.view?.me ?: return
        if (_ui.value.leaving) return
        _ui.update { it.copy(leaving = true, leaveFailed = false) }
        viewModelScope.launch {
            try {
                api.decide(me.id, Decision.Leave)
                _left.send(Unit)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _ui.update { it.copy(leaving = false, leaveFailed = true) }
            }
        }
    }
}
