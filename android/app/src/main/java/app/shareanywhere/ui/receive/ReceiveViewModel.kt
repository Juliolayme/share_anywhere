package app.shareanywhere.ui.receive

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.R
import app.shareanywhere.config.AppConfig
import app.shareanywhere.data.api.JoinPreview
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.sharing.CODE_LENGTH
import app.shareanywhere.sharing.JoinFlow
import app.shareanywhere.sharing.JoinSource
import app.shareanywhere.sharing.PendingJoin
import app.shareanywhere.sharing.UiMessage
import app.shareanywhere.sharing.joinErrorMessage
import app.shareanywhere.sharing.linkTokenFrom
import app.shareanywhere.sharing.normalizeCode
import app.shareanywhere.sharing.serverOffset
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

enum class ReceiveTab { Scan, Code }

data class ReceiveUi(
    val tab: ReceiveTab = ReceiveTab.Scan,
    val code: String = "",
    val busy: Boolean = false,
    val error: UiMessage? = null
) {
    val complete: Boolean get() = code.length == CODE_LENGTH
}

/** Where to go after a successful lookup. */
sealed interface ReceiveNav {
    data class Preview(val sessionId: String) : ReceiveNav

    /** This device already takes part (joined or waiting for approval): straight to the session. */
    data class Session(val sessionId: String) : ReceiveNav
}

/**
 * RX-1/RX-2/RX-3: QR scan, six-digit code and share links. Every lookup is a device-token call (guests included) that
 * the server counts toward its lookup and failed-lookup limits (docs/SECURITY_MODEL.md §3, §5); lockouts show the
 * wait time.
 */
@HiltViewModel
class ReceiveViewModel @Inject constructor(private val api: SessionsApi, private val flow: JoinFlow, private val config: AppConfig) :
    ViewModel() {
    private val _ui = MutableStateFlow(ReceiveUi())
    val ui: StateFlow<ReceiveUi> = _ui.asStateFlow()
    private val _nav = Channel<ReceiveNav>(Channel.BUFFERED)
    val nav = _nav.receiveAsFlow()

    fun setTab(tab: ReceiveTab) = _ui.update { it.copy(tab = tab, error = null) }

    fun setCode(raw: String) = _ui.update { it.copy(code = normalizeCode(raw), error = null) }

    fun submitCode() {
        val s = _ui.value
        if (s.busy) return
        if (!s.complete) return _ui.update { it.copy(error = UiMessage(R.string.product_code_incomplete)) }
        lookup(JoinSource.Code(s.code)) { api.resolveCode(s.code) }
    }

    /** A scanned QR payload or an opened link; anything that is not this app's share link is refused locally. */
    fun openLink(raw: String) {
        if (_ui.value.busy) return
        val token =
            linkTokenFrom(raw, config.publicUrl) ?: return _ui.update { it.copy(error = UiMessage(R.string.product_qr_not_share_link)) }
        lookup(JoinSource.Link(token)) { api.resolveLink(token) }
    }

    /** RX-3: an App Link `<public origin>/j/<token>` that MainActivity already matched to this app's origin. */
    fun openToken(token: String) {
        if (_ui.value.busy) return
        lookup(JoinSource.Link(token)) { api.resolveLink(token) }
    }

    private fun lookup(source: JoinSource, call: suspend () -> JoinPreview) {
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val preview = call()
                flow.put(PendingJoin(preview, serverOffset(preview.serverTime), source))
                _ui.update { it.copy(busy = false) }
                val already = preview.existingStatus == "JOINED" || preview.existingStatus == "REQUESTED"
                _nav.send(if (already) ReceiveNav.Session(preview.sessionId) else ReceiveNav.Preview(preview.sessionId))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(busy = false, error = joinErrorMessage(e)) }
            }
        }
    }
}
