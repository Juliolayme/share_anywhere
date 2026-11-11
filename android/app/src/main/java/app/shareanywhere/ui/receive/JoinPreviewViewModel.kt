package app.shareanywhere.ui.receive

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.sharing.JoinFlow
import app.shareanywhere.sharing.JoinSource
import app.shareanywhere.sharing.PendingJoin
import app.shareanywhere.sharing.UiMessage
import app.shareanywhere.sharing.joinErrorMessage
import app.shareanywhere.sharing.secondsUntil
import app.shareanywhere.ui.nav.Routes
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PreviewUi(val pending: PendingJoin?, val joining: Boolean = false, val error: UiMessage? = null)

/** RX-4 `rx-preview`: who sends what, and Receive (join). A lapsed join ticket is renewed while the window is open. */
@HiltViewModel
class JoinPreviewViewModel @Inject constructor(saved: SavedStateHandle, private val api: SessionsApi, private val flow: JoinFlow) :
    ViewModel() {
    private val sessionId: String = checkNotNull(saved[Routes.ID_ARG])
    private val _ui = MutableStateFlow(PreviewUi(flow.get(sessionId)))
    val ui: StateFlow<PreviewUi> = _ui.asStateFlow()
    private val _joined = Channel<String>(Channel.BUFFERED)
    val joined = _joined.receiveAsFlow()

    fun join() {
        val p = _ui.value.pending ?: return
        if (_ui.value.joining) return
        _ui.update { it.copy(joining = true, error = null) }
        viewModelScope.launch {
            try {
                var ticket = p.preview.joinTicket
                if (secondsUntil(p.preview.joinTicketExpiresAt, p.offset) == 0L) {
                    ticket =
                        when (val s = p.source) {
                            is JoinSource.Code -> api.resolveCode(s.code)
                            is JoinSource.Link -> api.resolveLink(s.token)
                        }.joinTicket
                }
                api.join(p.preview.sessionId, ticket)
                flow.clear()
                _joined.send(p.preview.sessionId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(joining = false, error = joinErrorMessage(e)) }
            }
        }
    }
}
