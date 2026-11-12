package app.shareanywhere.ui.send

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.R
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.CloudApi
import app.shareanywhere.data.api.CloudChoices
import app.shareanywhere.data.api.CloudEstimate
import app.shareanywhere.data.api.CloudSettings
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.data.api.OpenSessionList
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.sharing.OutgoingStore
import app.shareanywhere.sharing.PickedFile
import app.shareanywhere.sharing.PickedFiles
import app.shareanywhere.sharing.UiMessage
import app.shareanywhere.sharing.joinErrorMessage
import app.shareanywhere.sharing.mmss
import app.shareanywhere.sharing.serverOffset
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The device's open sessions, shown when Create hits the open-session cap (Web E16, docs/SECURITY_MODEL.md §5). */
sealed interface OpenSessions {
    data object Hidden : OpenSessions

    data object Loading : OpenSessions

    data object Failed : OpenSessions

    data class Ready(val list: OpenSessionList, val offset: Long) : OpenSessions
}

data class SendUi(
    val files: List<PickedFile> = emptyList(),
    val requireApproval: Boolean = false,
    val creating: Boolean = false,
    val error: UiMessage? = null,
    val unreadable: List<String> = emptyList(),
    val open: OpenSessions = OpenSessions.Hidden,
    val closingId: String? = null,
    /** Cloud Distribution (PRD §6.6): server availability and the account's state; null until read. */
    val cloudSettings: CloudSettings? = null,
    val cloud: Boolean = false,
    /** The consent dialog is open; its estimate once computed. */
    val consenting: Boolean = false,
    val estimate: CloudEstimate? = null,
    val cloudBusy: Boolean = false,
    val cloudError: UiMessage? = null
) {
    val total: Long get() = files.sumOf { it.size }
    val overLimit: Boolean get() = total > SESSION_LIMIT_BYTES || files.size > MAX_FILES
}

/** Matches the server's limits (docs/API.md §3 `over_limit`): 20 GB and 1,000 files per session. */
const val SESSION_LIMIT_BYTES = 20_000_000_000L
const val MAX_FILES = 1000

/**
 * TR-2/TR-3 `send`: picked files (SAF), Require approval (default off), and Create share session. Creating a session
 * needs only the device identity (PRD §2: no account). The picked documents' read access is persisted and mapped to
 * the server's file ids so the transfer engine can stream them.
 */
@HiltViewModel
class SendViewModel @Inject constructor(
    private val api: SessionsApi,
    private val picked: PickedFiles,
    private val outgoing: OutgoingStore,
    private val cloudApi: CloudApi,
    private val cloudChoices: CloudChoices
) : ViewModel() {
    private val _ui = MutableStateFlow(SendUi())
    val ui: StateFlow<SendUi> = _ui.asStateFlow()

    init {
        loadCloud()
    }

    /** Reads Cloud availability (and the account's consent) again, for example after signing in. */
    fun loadCloud() {
        viewModelScope.launch {
            val s = runCatching { cloudApi.settings() }.getOrNull()
            _ui.update { it.copy(cloudSettings = s, cloud = it.cloud && s?.signedIn == true) }
        }
    }

    /** Turning Cloud transfer on shows the estimate and asks for consent every time (PRD §6.6). */
    fun toggleCloud(on: Boolean) {
        if (!on) return _ui.update { it.copy(cloud = false) }
        _ui.update { it.copy(consenting = true, estimate = null, cloudError = null) }
        viewModelScope.launch {
            try {
                val e = cloudApi.estimate(_ui.value.total, 5)
                _ui.update { it.copy(estimate = e) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _ui.update { it.copy(consenting = false, cloudError = UiMessage(R.string.product_cloud_unavailable)) }
            }
        }
    }

    fun dismissCloud() = _ui.update { it.copy(consenting = false) }

    fun approveCloud() {
        val s = _ui.value.cloudSettings ?: return
        _ui.update { it.copy(cloudBusy = true) }
        viewModelScope.launch {
            try {
                val next = if (!s.enabled || !s.consented) cloudApi.putSettings(enabled = true, consent = true) else s
                _ui.update { it.copy(cloudSettings = next, cloud = true, consenting = false, cloudBusy = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _ui.update { it.copy(consenting = false, cloudBusy = false, cloudError = UiMessage(R.string.product_cloud_consent_needed)) }
            }
        }
    }
    private val _created = Channel<String>(Channel.BUFFERED)

    /** Session ids to open once created. */
    val created = _created.receiveAsFlow()

    fun add(uris: List<Uri>) {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val have = _ui.value.files.map { it.uri }.toSet()
            val fresh = uris.distinct().filter { it !in have }
            val described = withContext(Dispatchers.IO) { fresh.map { it to picked.describe(it) } }
            val ok = described.mapNotNull { it.second }
            val bad = described.filter {
                it.second == null
            }.map { it.first.lastPathSegment?.substringAfterLast('/') ?: it.first.toString() }
            _ui.update { it.copy(files = it.files + ok, unreadable = bad, error = null) }
        }
    }

    fun remove(file: PickedFile) = _ui.update { it.copy(files = it.files - file, error = null) }

    fun setRequireApproval(on: Boolean) = _ui.update { it.copy(requireApproval = on) }

    fun dismissUnreadable() = _ui.update { it.copy(unreadable = emptyList()) }

    fun create() {
        val s = _ui.value
        if (s.creating || s.files.isEmpty() || s.overLimit) return
        _ui.update { it.copy(creating = true, error = null) }
        viewModelScope.launch {
            try {
                val view = api.create(s.files.map { FileInput(it.name, it.size, it.mime) }, s.requireApproval)
                // The server keeps the order it was given (shared_files.position).
                val ids = view.files.orEmpty().map { it.id }.zip(s.files)
                outgoing.save(view.id, ids, System.currentTimeMillis())
                if (s.cloud) cloudChoices.choose(view.id)
                _ui.update { SendUi(requireApproval = it.requireApproval, cloudSettings = it.cloudSettings) }
                _created.send(view.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val cap = e is ApiException && e.code == "too_many_open_sessions"
                val msg =
                    when {
                        cap -> UiMessage(R.string.product_too_many_open)
                        e is ApiException && e.code == "over_limit" -> UiMessage(R.string.product_error_generic)
                        e is ApiException && e.status == 429 ->
                            UiMessage(R.string.product_rate_limited, mapOf("time" to mmss((e.retryAfterSeconds ?: 60).toLong())))
                        else -> joinErrorMessage(e)
                    }
                _ui.update { it.copy(creating = false, error = msg) }
                if (cap) loadOpen()
            }
        }
    }

    fun loadOpen() {
        _ui.update { it.copy(open = OpenSessions.Loading) }
        viewModelScope.launch {
            val next =
                try {
                    val list = api.listOpen()
                    OpenSessions.Ready(list, serverOffset(list.serverTime))
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    OpenSessions.Failed
                }
            _ui.update { it.copy(open = next) }
        }
    }

    fun closeOpen(id: String) {
        _ui.update { it.copy(closingId = id) }
        viewModelScope.launch {
            try {
                api.close(id)
                outgoing.release(id)
                _ui.update { it.copy(closingId = null, error = null) }
                loadOpen()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _ui.update { it.copy(closingId = null, error = UiMessage(R.string.product_close_failed)) }
            }
        }
    }
}
