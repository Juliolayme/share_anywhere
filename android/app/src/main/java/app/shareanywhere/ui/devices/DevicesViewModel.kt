package app.shareanywhere.ui.devices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.NetworkException
import app.shareanywhere.identity.IdentityManager
import app.shareanywhere.identity.IdentityState
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Outcome of Rename or Reset device identity, shown as a snackbar or inline under the field. */
sealed interface DeviceActionResult {
    data object Renamed : DeviceActionResult

    data object Reset : DeviceActionResult

    data object Offline : DeviceActionResult

    data class RateLimited(val seconds: Int) : DeviceActionResult

    data object RenameFailed : DeviceActionResult

    data object ResetFailed : DeviceActionResult
}

/** Display names are 1 to 40 characters after trimming (UpdateDeviceRequest in openapi.yaml). */
fun validDisplayName(name: String): Boolean = name.trim().length in 1..40

@HiltViewModel
class DevicesViewModel
@Inject
constructor(private val identity: IdentityManager) : ViewModel() {
    val identityState: StateFlow<IdentityState> = identity.state
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _result = MutableStateFlow<DeviceActionResult?>(null)
    val result: StateFlow<DeviceActionResult?> = _result.asStateFlow()

    fun retryIdentity() = identity.start()

    fun dismissReplaced() = identity.dismissReplaced()

    fun rename(name: String) = act(DeviceActionResult.Renamed, DeviceActionResult.RenameFailed) { identity.rename(name.trim()) }

    fun reset() = act(DeviceActionResult.Reset, DeviceActionResult.ResetFailed) { identity.reset() }

    fun resultShown() {
        _result.value = null
    }

    private fun act(ok: DeviceActionResult, failed: DeviceActionResult, block: suspend () -> Unit) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            _result.value =
                try {
                    block()
                    ok
                } catch (e: CancellationException) {
                    throw e
                } catch (e: NetworkException) {
                    DeviceActionResult.Offline
                } catch (e: ApiException) {
                    if (e.status == 429) DeviceActionResult.RateLimited(e.retryAfterSeconds ?: 60) else failed
                } catch (e: Exception) {
                    failed
                } finally {
                    _busy.value = false
                }
        }
    }
}
