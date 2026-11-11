package app.shareanywhere.ui.clipboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.R
import app.shareanywhere.account.AccountManager
import app.shareanywhere.account.AccountState
import app.shareanywhere.clipboard.CaptureResult
import app.shareanywhere.clipboard.ClipRead
import app.shareanywhere.clipboard.ClipboardRuntime
import app.shareanywhere.clipboard.ClipboardUi
import app.shareanywhere.clipboard.QueueReason
import app.shareanywhere.clipboard.SensitiveKind
import app.shareanywhere.data.api.ClipboardSettings
import app.shareanywhere.ui.account.UiText
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Android capture status (docs/UX_SCREEN_MAP.md §12: `foreground`, `offline`, `paused`, `error`). */
enum class CaptureStatus { Foreground, Offline, Paused, Error }

fun captureStatus(ui: ClipboardUi): CaptureStatus = when {
    ui.snapshot.settings?.paused == true -> CaptureStatus.Paused
    !ui.online -> CaptureStatus.Offline
    ui.snapshot.loadError != null || ui.snapshot.sendError != null -> CaptureStatus.Error
    else -> CaptureStatus.Foreground
}

/** What a Sync Clipboard tap or a sheet action ended with: a toast, an inline line, or a sensitive prompt. */
sealed interface SyncOutcome {
    data class Toast(val text: UiText) : SyncOutcome

    data class Inline(val text: UiText) : SyncOutcome

    /** Possibly sensitive: "Sync anyway" sends [text] with force. */
    data class Sensitive(val text: String, val kind: SensitiveKind) : SyncOutcome

    /** Android did not share the clipboard: the paste fallback opens. */
    data object Paste : SyncOutcome
}

fun queuedText(reason: QueueReason): UiText = UiText(
    when (reason) {
        QueueReason.OFFLINE -> R.string.phrases_encrypted_and_queued_will_send_when_online
        QueueReason.BUSY -> R.string.product_cb_queued_busy
        QueueReason.RATE_LIMITED -> R.string.product_cb_queued_rate_limited
        QueueReason.KEY -> R.string.product_cb_queued_key
        QueueReason.PAUSED -> R.string.product_cb_queued_paused
        QueueReason.PENDING -> R.string.product_cb_queued
    }
)

fun outcomeOf(r: CaptureResult, text: String): SyncOutcome? = when (r) {
    is CaptureResult.Synced -> SyncOutcome.Toast(UiText(R.string.phrases_clipboard_synced_encrypted))
    is CaptureResult.Queued -> SyncOutcome.Toast(queuedText(r.reason))
    is CaptureResult.Removed -> null
    is CaptureResult.Sensitive -> SyncOutcome.Sensitive(text, r.kind)
    CaptureResult.Duplicate -> SyncOutcome.Inline(UiText(R.string.product_cb_duplicate))
    CaptureResult.Empty -> SyncOutcome.Inline(UiText(R.string.product_cb_empty_clip))
    CaptureResult.TooLarge -> SyncOutcome.Inline(UiText(R.string.product_cb_too_large))
    CaptureResult.Paused -> SyncOutcome.Inline(UiText(R.string.phrases_resume_sync_first))
    CaptureResult.NotReady -> SyncOutcome.Inline(UiText(R.string.product_error_generic))
}

@HiltViewModel
class ClipboardViewModel
@Inject
constructor(private val runtime: ClipboardRuntime, private val account: AccountManager) : ViewModel() {
    val ui: StateFlow<ClipboardUi> = runtime.ui
    val accountState: StateFlow<AccountState> = account.state

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()
    private val _outcome = MutableStateFlow<SyncOutcome?>(null)
    val outcome: StateFlow<SyncOutcome?> = _outcome.asStateFlow()

    fun outcomeShown() {
        _outcome.value = null
    }

    private fun act(errorText: Int, block: suspend () -> SyncOutcome?) {
        viewModelScope.launch {
            _outcome.value =
                try {
                    block()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    SyncOutcome.Toast(UiText(errorText))
                }
        }
    }

    /** Sync Clipboard: reads the clipboard now and sends it. */
    fun syncNow() {
        if (_syncing.value) return
        _syncing.value = true
        viewModelScope.launch {
            try {
                val (read, result) = runtime.syncNow()
                _outcome.value =
                    when (read) {
                        is ClipRead.Text -> result?.let { outcomeOf(it, read.text) }
                        ClipRead.Empty -> SyncOutcome.Inline(UiText(R.string.product_cb_empty_clip))
                        ClipRead.Refused -> SyncOutcome.Paste
                    }
            } finally {
                _syncing.value = false
            }
        }
    }

    /** "Sync anyway" after a sensitive skip, or the paste fallback's "Sync this text". */
    fun send(text: String, force: Boolean) = act(R.string.product_cb_send_failed) {
        outcomeOf(runtime.capture(text, app.shareanywhere.clipboard.CaptureSource.MANUAL, force = force), text)
    }

    fun copy(id: String) = act(R.string.product_cb_copy_failed_android) {
        if (runtime.copy(
                id
            )
        ) {
            SyncOutcome.Toast(
                UiText(R.string.phrases_copied_to_clipboard)
            )
        } else {
            SyncOutcome.Toast(UiText(R.string.product_cb_copy_failed_android))
        }
    }

    fun delete(id: String) = act(R.string.product_cb_delete_failed) {
        runtime.remove(id)
        SyncOutcome.Toast(UiText(R.string.phrases_item_deleted_on_all_devices))
    }

    fun clear() = act(R.string.product_cb_clear_failed) {
        runtime.clear()
        SyncOutcome.Toast(UiText(R.string.android_yy_n_cbcleared))
    }

    fun refresh() = viewModelScope.launch { runCatching { runtime.refresh() } }

    fun retrySend() = viewModelScope.launch { runCatching { runtime.flush() } }

    fun retrySettings() = viewModelScope.launch { runCatching { runtime.retrySettings() } }

    fun dismissSkipped(id: String) = viewModelScope.launch { runtime.dismissSkipped(id) }

    fun setAutoCapture(on: Boolean) = viewModelScope.launch { runtime.setAutoCapture(on) }

    fun saveSettings(next: ClipboardSettings) = act(R.string.product_cb_settings_failed) {
        runtime.saveSettings(next)
        null
    }

    fun setPaused(paused: Boolean) {
        val s = ui.value.snapshot.settings ?: return
        saveSettings(s.copy(paused = paused))
    }

    fun retryKeys() = viewModelScope.launch { account.checkKeys() }
}
