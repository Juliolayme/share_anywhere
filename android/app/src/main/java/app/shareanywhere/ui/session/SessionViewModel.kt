package app.shareanywhere.ui.session

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.R
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.Decision
import app.shareanywhere.data.api.Participant
import app.shareanywhere.data.api.SessionView
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.data.api.UpdateSessionRequest
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.data.ws.SocketEvent
import app.shareanywhere.notify.Notifier
import app.shareanywhere.sharing.LIVE_STATUSES
import app.shareanywhere.sharing.OutgoingStore
import app.shareanywhere.sharing.UiMessage
import app.shareanywhere.sharing.serverOffset
import app.shareanywhere.transfer.TransferService
import app.shareanywhere.transfer.runtime.SenderController
import app.shareanywhere.transfer.runtime.TransferRuntime
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.nav.Routes
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

enum class LoadError { NotFound, Failed }

data class SessionUi(
    val view: SessionView? = null,
    val offset: Long = 0,
    val loadError: LoadError? = null,
    /** The action in flight: "stop", "renew", "approval", "close", or a participant id. */
    val busy: String? = null
)

/**
 * TR-4/TR-5 sender session: loads the session, follows live events over the WebSocket (reloading on every
 * participant or session event and after each reconnect), and runs the sender's actions. Joins and requests show a
 * snackbar, and a local notification while the app is in the background.
 */
@HiltViewModel
class SessionViewModel @Inject constructor(
    saved: SavedStateHandle,
    private val api: SessionsApi,
    private val socket: SessionSocket,
    private val notifier: Notifier,
    private val outgoing: OutgoingStore,
    private val runtime: TransferRuntime,
    private val json: Json,
    @ApplicationContext private val context: Context
) : ViewModel() {
    val id: String = checkNotNull(saved[Routes.ID_ARG])
    private val _ui = MutableStateFlow(SessionUi())
    val ui: StateFlow<SessionUi> = _ui.asStateFlow()
    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()
    private val loadLock = Mutex()
    private var socketJob: Job? = null

    /** Serves receivers' offers while the session is live (docs/TRANSFER_PROTOCOL.md §1), kept by the runtime. */
    private val _sender = MutableStateFlow<SenderController?>(null)
    val sender: StateFlow<SenderController?> = _sender.asStateFlow()

    init {
        viewModelScope.launch {
            ui.collect { u ->
                val v = u.view ?: return@collect
                if (_sender.value == null && v.status in LIVE_STATUSES) _sender.value = runtime.sender(id)
                // A joined receiver will offer soon: keep the process serving with the screen off.
                if (v.status in LIVE_STATUSES && (v.capacity?.joined ?: 0) > 0) TransferService.start(context)
            }
        }
        load()
        socketJob = viewModelScope.launch { socket.subscribe().collect(::onEvent) }
    }

    fun load() {
        viewModelScope.launch {
            loadLock.withLock {
                try {
                    val v = api.get(id)
                    // An ended session's files are no longer offered (the transfer engine keeps them while it runs, 6.3).
                    if (v.status == "CLOSED" || v.status == "EXPIRED" || v.status == "CANCELLED") outgoing.release(id)
                    _ui.update { it.copy(view = v, offset = serverOffset(v.serverTime), loadError = null) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _ui.update { it.copy(loadError = if (e is ApiException && e.status == 404) LoadError.NotFound else LoadError.Failed) }
                }
            }
        }
    }

    private fun onEvent(e: SocketEvent) {
        if (e.type == SocketEvent.OPEN || e.type == "PROTECTED_MODE") return load()
        if (e.sessionId != id) return
        val p = participantOf(e.body)
        when (e.type) {
            "PARTICIPANT_JOINED" -> p?.let { announce(it, R.string.product_peer_joined) }
            "PARTICIPANT_REQUESTED" -> p?.let { announce(it, R.string.product_wants_to_join) }
        }
        load()
    }

    private fun announce(p: Participant, text: Int) {
        val msg = UiMessage(text, mapOf("name" to p.displayName))
        if (!notifier.sessionActivity(id, p.id, context.str(text, "name" to p.displayName))) _messages.trySend(msg)
    }

    private fun participantOf(body: JsonObject): Participant? =
        body["participant"]?.let { runCatching { json.decodeFromJsonElement(Participant.serializer(), it) }.getOrNull() }

    fun stopAccepting() = act("stop") { api.update(id, UpdateSessionRequest(acceptingReceivers = false)) }

    fun renew() = act("renew") { api.renew(id) }

    fun setRequireApproval(on: Boolean) = act("approval") { api.update(id, UpdateSessionRequest(requireApproval = on)) }

    fun approve(p: Participant) = act(p.id) { api.decide(p.id, Decision.Approve) }

    fun reject(p: Participant) = act(p.id) { api.decide(p.id, Decision.Reject) }

    fun remove(p: Participant) = act(p.id) { api.remove(p.id) }

    fun block(p: Participant) = act(p.id) { api.decide(p.id, Decision.Block) }

    fun close() = act("close", failure = UiMessage(R.string.product_close_failed)) {
        api.close(id)
        outgoing.release(id)
    }

    private fun act(key: String, failure: UiMessage? = null, block: suspend () -> Unit) {
        if (_ui.value.busy != null) return
        _ui.update { it.copy(busy = key) }
        viewModelScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.trySend(
                    when {
                        e is ApiException && e.code == "session_full" -> UiMessage(R.string.product_session_full_rx)
                        failure != null -> failure
                        else -> UiMessage(R.string.product_error_generic)
                    }
                )
            } finally {
                _ui.update { it.copy(busy = null) }
                load()
            }
        }
    }
}
