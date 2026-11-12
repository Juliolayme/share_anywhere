package app.shareanywhere.transfer.runtime

import android.content.Context
import app.shareanywhere.data.api.CloudApi
import app.shareanywhere.data.api.CloudChoices
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.data.api.TransfersApi
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.transfer.IncomingDao
import app.shareanywhere.transfer.OutgoingFileDao
import app.shareanywhere.transfer.TransferService
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/** What the foreground service and Transfer home show: work in progress across every session. */
data class TransferActivity(
    /** Receivers being served right now (connecting, transferring, reconnecting, verifying). */
    val sendingTo: Int = 0,
    val sendVerified: Long = 0,
    val sendTotal: Long = 0,
    /** Files being received right now. */
    val receivingFiles: Int = 0,
    val receiveVerified: Long = 0,
    val receiveTotal: Long = 0,
    /** Work that keeps the service alive: an unfinished receive, or joined receivers still being served. */
    val pending: Boolean = false,
    /** The session a notification tap opens (receiver: rx; sender: session). */
    val sessionId: String? = null,
    val receiving: Boolean = false
) {
    val moving: Boolean get() = sendingTo > 0 || receivingFiles > 0
}

/**
 * Owns every transfer controller of the process (one sender or receiver per session), so transfers outlive screens
 * and keep running behind the foreground service while the screen is off.
 */
class TransferRuntime(
    private val context: Context,
    private val sessions: SessionsApi,
    private val transfers: TransfersApi,
    private val socket: SessionSocket,
    private val outgoing: OutgoingFileDao,
    private val incoming: IncomingDao,
    private val history: HistoryRepository,
    private val json: Json,
    private val scope: CoroutineScope,
    private val cloud: CloudApi? = null,
    private val cloudChoices: CloudChoices? = null
) {
    private val senders = ConcurrentHashMap<String, SenderController>()
    private val receivers = ConcurrentHashMap<String, ReceiverController>()
    private val _activity = MutableStateFlow(TransferActivity())
    val activity: StateFlow<TransferActivity> = _activity.asStateFlow()
    private var watcher: Job? = null

    // The controller is in the map before rewatch() runs: rewatch() reads the maps, and a controller added after it
    // would not drive the activity (foreground service, notification) until some other session came or went.
    @Synchronized
    fun sender(sessionId: String): SenderController = senders[sessionId]
        ?: SenderController(
            SenderDeps(
                context, sessionId, sessions, transfers, socket, outgoing, history, json,
                cloud = cloud?.takeIf { cloudChoices?.chosen(sessionId) == true }
            )
        ).also {
            it.init()
            senders[sessionId] = it
            rewatch()
        }

    @Synchronized
    fun receiver(sessionId: String): ReceiverController = receivers[sessionId]
        ?: ReceiverController(ReceiverDeps(context, sessionId, sessions, transfers, socket, incoming, history, json, cloud = cloud)).also {
            it.init()
            receivers[sessionId] = it
            rewatch()
        }

    fun existingReceiver(sessionId: String): ReceiverController? = receivers[sessionId]

    /**
     * Next launch after the process ended mid-receive (PRD §6 "resume on next launch"): recreates the receiver of
     * every unfinished receive with a saved folder. Each reloads its session and, while this device is still a
     * joined receiver, reconnects and resumes from its persisted bitmap; a session that ended meanwhile settles on
     * its final state.
     */
    suspend fun resumeUnfinished(): List<String> {
        val ids = runCatching { incoming.unfinishedSessions() }.getOrDefault(emptyList())
        for (id in ids) if (receivers[id] == null) receiver(id)
        return ids
    }

    /** The service's time budget ran out: pause every transfer (bitmaps are persisted; resume picks up). */
    fun pauseAll() {
        for (r in receivers.values) r.pause()
        for (c in senders.values) c.pauseAll()
    }

    /** Forgets a finished session's controller (after its result was shown). */
    @Synchronized
    fun release(sessionId: String) {
        senders.remove(sessionId)?.dispose()
        receivers.remove(sessionId)?.dispose()
        rewatch()
    }

    private fun foreground() =
        androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)

    @Synchronized
    private fun rewatch() {
        watcher?.cancel()
        val tx = senders.entries.toList()
        val rx = receivers.entries.toList()
        val flows = tx.map { (id, c) -> c.state.toActivity(id) } + rx.map { (id, c) -> c.state.toActivity(id) }
        if (flows.isEmpty()) {
            _activity.value = TransferActivity()
            return
        }
        watcher =
            scope.launch {
                combine(flows) { parts -> parts.fold(TransferActivity()) { a, b -> a.merge(b) } }.collect {
                    _activity.value = it
                    // Transfer work keeps a foreground service running (docs/ADR/0020-android-background-transfers.md);
                    // it can only be started while the app is in front.
                    if ((it.pending || it.moving) && !TransferService.running && foreground()) TransferService.start(context)
                }
            }
    }

    private fun StateFlow<TxState>.toActivity(id: String) = kotlinx.coroutines.flow.flow {
        collect { s ->
            val moving = s.receivers.filter { it.status.active() }
            emit(
                TransferActivity(
                    sendingTo = moving.size,
                    sendVerified = moving.sumOf { it.verified },
                    sendTotal = moving.sumOf { it.total },
                    pending = s.hasFiles &&
                        !s.ended &&
                        s.receivers.any {
                            it.joined && !it.status.ended() && it.status != TxStatus.Offline
                        },
                    sessionId = id.takeIf { moving.isNotEmpty() }
                )
            )
        }
    }

    @JvmName("rxActivity")
    private fun StateFlow<RxState>.toActivity(id: String) = kotlinx.coroutines.flow.flow {
        collect { s ->
            val moving = s.phase.active()
            emit(
                TransferActivity(
                    receivingFiles = if (moving) s.files.count { !it.done && !it.failed }.coerceAtLeast(1) else 0,
                    receiveVerified = if (moving) s.verified else 0,
                    receiveTotal = if (moving) s.total else 0,
                    pending = !s.phase.final() && s.phase != RxPhase.Loading && s.phase != RxPhase.Choose && s.phase != RxPhase.Unreachable,
                    sessionId = id.takeIf { moving },
                    receiving = moving
                )
            )
        }
    }

    private fun TransferActivity.merge(b: TransferActivity) = TransferActivity(
        sendingTo + b.sendingTo,
        sendVerified + b.sendVerified,
        sendTotal + b.sendTotal,
        receivingFiles + b.receivingFiles,
        receiveVerified + b.receiveVerified,
        receiveTotal + b.receiveTotal,
        pending || b.pending,
        sessionId ?: b.sessionId,
        receiving || b.receiving
    )
}
