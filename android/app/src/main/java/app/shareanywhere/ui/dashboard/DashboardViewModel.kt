package app.shareanywhere.ui.dashboard

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import app.shareanywhere.transfer.TransferService
import app.shareanywhere.transfer.runtime.SenderController
import app.shareanywhere.transfer.runtime.TransferRuntime
import app.shareanywhere.ui.nav.Routes
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject

/** TR-6/TR-7: the session's sender controller, kept by the runtime so transfers outlive this screen. */
@HiltViewModel
class DashboardViewModel @Inject constructor(
    saved: SavedStateHandle,
    private val runtime: TransferRuntime,
    @ApplicationContext private val context: Context
) : ViewModel() {
    val sessionId: String = checkNotNull(saved[Routes.ID_ARG])
    val sender: SenderController = runtime.sender(sessionId)
    val state = sender.state

    init {
        TransferService.start(context)
    }

    fun pause(pid: String) = sender.pause(pid)

    fun resume(pid: String) {
        sender.resume(pid)
        TransferService.start(context)
    }

    fun cancel(pid: String) = sender.cancel(pid)

    fun stopAll() = sender.cancelAll()

    fun done() = runtime.release(sessionId)
}
