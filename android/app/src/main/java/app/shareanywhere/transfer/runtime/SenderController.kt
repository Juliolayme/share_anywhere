package app.shareanywhere.transfer.runtime

import android.content.Context
import androidx.core.net.toUri
import app.shareanywhere.data.api.SessionView
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.data.api.Transfer
import app.shareanywhere.data.api.TransferList
import app.shareanywhere.data.api.TransfersApi
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.data.ws.SocketEvent
import app.shareanywhere.history.Direction
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryFile
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.history.HistoryRoute
import app.shareanywhere.history.HistoryStatus
import app.shareanywhere.transfer.OutgoingFileDao
import app.shareanywhere.transfer.engine.BlockCache
import app.shareanywhere.transfer.engine.ErrorCodes
import app.shareanywhere.transfer.engine.FileHash
import app.shareanywhere.transfer.engine.SenderConnection
import app.shareanywhere.transfer.engine.SenderEvents
import app.shareanywhere.transfer.engine.SenderFile
import app.shareanywhere.transfer.engine.SenderOptions
import app.shareanywhere.transfer.engine.hex
import app.shareanywhere.transfer.engine.sha256
import app.shareanywhere.transfer.rtc.CHANNEL_LABEL
import app.shareanywhere.transfer.rtc.CandidateJson
import app.shareanywhere.transfer.rtc.CandidatePayload
import app.shareanywhere.transfer.rtc.DataChannelAdapter
import app.shareanywhere.transfer.rtc.Rtc
import app.shareanywhere.transfer.rtc.SdpPayload
import app.shareanywhere.transfer.rtc.createAnswerAwait
import app.shareanywhere.transfer.rtc.selectedRoute
import app.shareanywhere.transfer.rtc.setLocalAwait
import app.shareanywhere.transfer.rtc.setRemoteAwait
import app.shareanywhere.transfer.rtc.toCandidate
import app.shareanywhere.transfer.rtc.toJson
import app.shareanywhere.transfer.rtc.toSdp
import app.shareanywhere.transfer.storage.SafSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection

enum class TxStatus {
    Waiting,
    Offline,
    Connecting,
    Transferring,
    Paused,
    Reconnecting,
    Verifying,
    Completed,
    Failed,
    Cancelled,
    Removed,
    Blocked
}

fun TxStatus.active() =
    this == TxStatus.Connecting || this == TxStatus.Transferring || this == TxStatus.Reconnecting || this == TxStatus.Verifying

fun TxStatus.ended() = this == TxStatus.Completed ||
    this == TxStatus.Failed ||
    this == TxStatus.Cancelled ||
    this == TxStatus.Removed ||
    this == TxStatus.Blocked

fun TxStatus.excluded() = this == TxStatus.Removed || this == TxStatus.Blocked

data class TxReceiver(
    val participantId: String,
    val name: String,
    val platform: String,
    val joined: Boolean,
    val delivered: Boolean,
    val status: TxStatus,
    val perFile: List<Long>,
    val verified: Long,
    val total: Long,
    val route: String?,
    val bytesPerSecond: Double = 0.0,
    val eta: Long? = null,
    val error: String? = null
)

data class TxFile(val index: Int, val fileId: String, val name: String, val size: Long, val mime: String)

enum class TxFinal { Completed, Partial, Failed, Cancelled }

data class TxState(
    val loaded: Boolean = false,
    val files: List<TxFile> = emptyList(),
    val receivers: List<TxReceiver> = emptyList(),
    /** This device still holds read access to every picked file. */
    val hasFiles: Boolean = false,
    val final: TxFinal? = null,
    val ended: Boolean = false
)

/** One receiver as the result rule sees it (docs/ARCHITECTURE.md §4.5, the server's EndStatus). */
data class ResultInput(val status: TxStatus, val delivered: Boolean, val done: Int, val total: Int)

object SessionResult {
    fun counts(r: ResultInput) = !r.status.excluded() || r.delivered

    fun final(rs: List<ResultInput>): TxFinal {
        val counted = rs.filter(::counts)
        var total = 0
        var done = 0
        for (r in counted) {
            total += r.total
            done += if (r.status == TxStatus.Completed || r.delivered) r.total else minOf(r.total, r.done)
        }
        return when {
            total > 0 && done == total -> TxFinal.Completed
            done > 0 -> TxFinal.Partial
            counted.any { it.status == TxStatus.Failed } -> TxFinal.Failed
            else -> TxFinal.Cancelled
        }
    }

    /** The TR-7 result, or null while undecided (a live session can still take receivers). */
    fun of(rs: List<ResultInput>, ended: Boolean): TxFinal? {
        if (rs.isEmpty()) return null
        if (ended) return final(rs)
        if (rs.none(::counts) || !rs.all { it.status.ended() }) return null
        return final(rs)
    }

    /** Group ETA: the slowest active receiver; null while any active one has no estimate; -1 when nobody is active. */
    fun groupEta(rs: List<TxReceiver>): Long? {
        val active = rs.filter { it.status.active() }
        if (active.isEmpty()) return -1
        if (active.any { it.eta == null }) return null
        return active.maxOf { it.eta ?: 0 }
    }

    fun statusFromServer(ts: List<String>): TxStatus? = when {
        ts.isEmpty() -> null
        ts.all { it == "COMPLETED" } -> TxStatus.Completed
        ts.all { Transitions.terminal(it) } -> if ("CANCELLED" in ts && "FAILED" !in ts) TxStatus.Cancelled else TxStatus.Failed
        "PAUSED" in ts -> TxStatus.Paused
        ts.any { it == "DISCONNECTED" || it == "RECONNECTING" } -> TxStatus.Reconnecting
        ts.any { it == "TRANSFERRING" || it == "RESUMING" } -> TxStatus.Transferring
        "CONNECTING" in ts -> TxStatus.Connecting
        else -> TxStatus.Waiting
    }
}

class SenderDeps(
    val context: Context,
    val sessionId: String,
    val sessions: SessionsApi,
    val transfers: TransfersApi,
    val socket: SessionSocket,
    val outgoing: OutgoingFileDao,
    val history: HistoryRepository,
    val json: Json,
    val clock: () -> Long = System::currentTimeMillis
)

/**
 * Serves every receiver of one session from this device (docs/TRANSFER_PROTOCOL.md), the Android twin of the Web's
 * SenderController: answers each JOINED receiver's offer, authorizes HELLO against the capability hash, shares one
 * block cache and whole-file hash across receivers, tracks the 10-minute Offline window, and writes History.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SenderController(private val d: SenderDeps) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
    private val _state = MutableStateFlow(TxState())
    val state: StateFlow<TxState> = _state.asStateFlow()
    private val s get() = _state.value

    private class Peer(val pc: PeerConnection, val connId: String, val throughput: Throughput) {
        var conn: SenderConnection? = null
        var channel: DataChannelAdapter? = null
        var ready = false
    }

    private val peers = HashMap<String, Peer>()
    private var gone = emptySet<String>()
    private val transfers = HashMap<String, Transfer>()
    private val downTimers = HashMap<String, Job>()
    private val resuming = HashSet<String>()
    private val pendingIce = HashMap<String, LinkedHashMap<String, MutableList<CandidateJson>>>()
    private val hashes = HashMap<Int, FileHash>()
    private val cache = BlockCache()
    private var senderFiles: List<SenderFile> = emptyList()
    private val sources = mutableListOf<SafSource>()
    private var list: TransferList? = null
    private var historyKey = ""
    private var startedAt: Long? = null
    private var socketJob: Job? = null
    private var samplerJob: Job? = null
    private var loaded: Job? = null

    private fun update(f: (TxState) -> TxState) = _state.update(f)

    fun init() {
        if (loaded != null) return
        loaded = scope.launch { runCatching { load() } }
    }

    private suspend fun load() {
        val view = d.sessions.get(d.sessionId)
        val files = view.files.orEmpty().mapIndexed { i, f -> TxFile(i, f.id, f.name, f.size, f.mime) }
        val rows = d.outgoing.forSession(d.sessionId)
        if (rows.size == files.size && files.isNotEmpty() && rows.zip(files).all { (r, f) -> r.fileId == f.fileId && r.size == f.size }) {
            senderFiles =
                files.zip(rows).map { (f, r) ->
                    val src = SafSource(d.context.contentResolver, r.uri.toUri(), f.size).also { sources += it }
                    SenderFile(f.index, f.fileId, "", f.name, f.size, f.mime, src)
                }
            for (f in senderFiles) hashes[f.index] = FileHash(f.source, scope)
        }
        update { it.copy(files = files, hasFiles = senderFiles.size == files.size && files.isNotEmpty()) }
        socketJob = scope.launch { d.socket.subscribe().collect { onSocket(it) } }
        refresh(view)
        samplerJob =
            scope.launch {
                while (isActive) {
                    delay(500)
                    sample()
                }
            }
        update { it.copy(loaded = true) }
    }

    suspend fun refresh(view: SessionView? = null) {
        val v = view ?: runCatching { d.sessions.get(d.sessionId) }.getOrNull() ?: return
        val l = runCatching { d.transfers.list(d.sessionId) }.getOrNull() ?: return
        list = l
        for (t in l.transfers) transfers[t.id] = t
        val total = s.files.sumOf { it.size }
        val receivers =
            v.participants.orEmpty()
                .filter { p -> p.role == "receiver" && p.status in setOf("JOINED", "REMOVED", "BLOCKED", "LEFT") }
                .filter { p ->
                    p.status == "JOINED" ||
                        l.transfers.any { t -> t.participantId == p.id && (t.verifiedBytes > 0 || t.status != "PENDING") }
                }
                .map { p ->
                    val prev = s.receivers.firstOrNull { it.participantId == p.id }
                    val mine = l.transfers.filter { it.participantId == p.id }
                    val perFile = s.files.map { f -> mine.firstOrNull { it.fileId == f.fileId }?.verifiedBytes ?: 0 }
                    val server = SessionResult.statusFromServer(mine.map { it.status })
                    val removed = p.status != "JOINED"
                    val settled = server?.takeIf { it == TxStatus.Completed || it == TxStatus.Failed || it == TxStatus.Cancelled }
                    var status =
                        when {
                            p.status == "BLOCKED" -> TxStatus.Blocked
                            p.status == "REMOVED" -> TxStatus.Removed
                            removed -> settled ?: TxStatus.Cancelled
                            prev != null && settled == null -> prev.status
                            else -> server ?: TxStatus.Waiting
                        }
                    if (!removed && server != null && !live(p.id) && settled == null) {
                        if (server == TxStatus.Paused) {
                            status = TxStatus.Paused
                        } else if (status == TxStatus.Paused || status == TxStatus.Transferring || status == TxStatus.Verifying) {
                            status = TxStatus.Reconnecting
                        }
                    }
                    val merged = prev?.perFile?.mapIndexed { i, n -> maxOf(n, perFile.getOrElse(i) { 0 }) } ?: perFile
                    TxReceiver(
                        p.id, p.displayName, p.platform, !removed, mine.isNotEmpty() && mine.all { it.status == "COMPLETED" }, status,
                        merged, merged.sum(), total, prev?.route ?: mine.firstOrNull { it.route != null }?.route,
                        prev?.bytesPerSecond ?: 0.0, prev?.eta, prev?.error
                    )
                }
        update { it.copy(receivers = receivers, ended = it.ended || (v.status != "WAITING" && v.status != "ACTIVE")) }
        gone = v.participants.orEmpty().filter { it.role == "receiver" && it.status != "JOINED" }.map { it.id }.toSet()
        for (pid in gone) drop(pid)
        val joined = receivers.filter { it.participantId !in gone }.map { it.participantId }.toSet()
        pendingIce.keys.retainAll(joined)
        for (r in receivers) syncWindow(r.participantId)
        checkFinal()
    }

    fun pause(pid: String) = scope.launch {
        resuming -= pid
        peers[pid]?.conn?.pause()
        patch(pid) { it.copy(status = TxStatus.Paused) }
        for (t in openTransfers(pid)) runCatching { d.transfers.action(t.id, TransfersApi.Action.Pause) }
    }

    fun resume(pid: String) = scope.launch {
        resuming += pid
        patch(pid) { it.copy(status = if (live(pid)) TxStatus.Transferring else TxStatus.Reconnecting) }
        for (t in openTransfers(pid)) runCatching { d.transfers.action(t.id, TransfersApi.Action.Resume) }.onFailure { resuming -= pid }
        peers[pid]?.conn?.resume()
    }

    fun cancel(pid: String) = scope.launch { cancelNow(pid) }

    private suspend fun cancelNow(pid: String) {
        peers[pid]?.conn?.cancel()
        patch(pid) { it.copy(status = TxStatus.Cancelled) }
        for (t in openTransfers(pid)) runCatching { d.transfers.action(t.id, TransfersApi.Action.Cancel) }
        checkFinal()
    }

    fun pauseAll() = scope.launch { for (r in s.receivers) if (r.status.active()) pause(r.participantId) }

    /** Stop all (TR-6): cancels every transfer still going. */
    fun cancelAll() = scope.launch { for (r in s.receivers) if (!r.status.ended()) cancelNow(r.participantId) }

    fun dispose() = scope.launch {
        socketJob?.cancel()
        samplerJob?.cancel()
        downTimers.values.forEach { it.cancel() }
        downTimers.clear()
        pendingIce.clear()
        cache.clear()
        for (pid in peers.keys.toList()) drop(pid)
        withContext(Dispatchers.IO) { sources.forEach { it.close() } }
        scope.cancel()
    }

    val active: Boolean get() = s.receivers.any { it.status.active() }

    private fun drop(pid: String) {
        val p = peers.remove(pid) ?: return
        p.conn?.close()
        p.channel?.dispose()
        runCatching { p.pc.dispose() }
    }

    private fun openTransfers(pid: String) = transfers.values.filter { it.participantId == pid && !Transitions.terminal(it.status) }

    private fun patch(pid: String, f: (TxReceiver) -> TxReceiver) {
        val before = s.receivers.firstOrNull { it.participantId == pid }?.status
        update { st -> st.copy(receivers = st.receivers.map { if (it.participantId == pid) f(it) else it }) }
        if (s.receivers.firstOrNull { it.participantId == pid }?.status != before) syncWindow(pid)
    }

    /** Reconnect window: connecting or reconnecting with no open channel for 10 minutes shows Offline. */
    private fun syncWindow(pid: String) {
        val r = s.receivers.firstOrNull { it.participantId == pid }
        val down = r != null && (r.status == TxStatus.Reconnecting || r.status == TxStatus.Connecting) && !live(pid)
        if (!down) {
            downTimers.remove(pid)?.cancel()
            return
        }
        if (downTimers[pid]?.isActive == true) return
        downTimers[pid] =
            scope.launch {
                delay(RECONNECT_WINDOW_MS)
                downTimers.remove(pid)
                val cur = s.receivers.firstOrNull { it.participantId == pid }
                if ((cur?.status == TxStatus.Reconnecting || cur?.status == TxStatus.Connecting) &&
                    !live(pid)
                ) {
                    patch(pid) { it.copy(status = TxStatus.Offline) }
                }
            }
    }

    private suspend fun onSocket(e: SocketEvent) {
        val from = e.body["from"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val payload = e.body["payload"] as? JsonObject
        when {
            e.type == "OFFER" && from.isNotEmpty() && payload != null -> {
                val sdp = runCatching { d.json.decodeFromJsonElement(SdpPayload.serializer(), payload) }.getOrNull() ?: return
                if (sdp.conn.length > 64) return
                onOffer(from, sdp)
            }
            e.type == "ICE_CANDIDATE" && from.isNotEmpty() && payload != null -> {
                val c = runCatching { d.json.decodeFromJsonElement(CandidatePayload.serializer(), payload) }.getOrNull() ?: return
                val cand = c.candidate?.let(::sanitize) ?: return
                if (c.conn.length > 64) return
                val p = peers[from]
                if (p != null &&
                    c.conn == p.connId &&
                    p.ready
                ) {
                    runCatching { p.pc.addIceCandidate(cand.toCandidate()) }
                } else {
                    hold(from, c.conn, cand)
                }
            }
            e.type == "TRANSFER_UPDATED" -> {
                val t = runCatching { d.json.decodeFromJsonElement(Transfer.serializer(), e.body["transfer"]!!) }.getOrNull() ?: return
                transfers[t.id] = t
                val server = SessionResult.statusFromServer(
                    transfers.values.filter {
                        it.participantId == t.participantId
                    }.map { it.status }
                )
                val r = s.receivers.firstOrNull { it.participantId == t.participantId }
                if (r != null &&
                    server != null &&
                    server in setOf(TxStatus.Completed, TxStatus.Failed, TxStatus.Cancelled) &&
                    !r.status.excluded()
                ) {
                    patch(r.participantId) { it.copy(status = server) }
                }
                if (server != TxStatus.Paused) resuming -= t.participantId
                if (r != null &&
                    server == TxStatus.Paused &&
                    r.status.active() &&
                    r.participantId !in resuming
                ) {
                    patch(r.participantId) { it.copy(status = TxStatus.Paused) }
                }
                if (r != null &&
                    r.status == TxStatus.Paused &&
                    server in setOf(TxStatus.Transferring, TxStatus.Connecting, TxStatus.Reconnecting)
                ) {
                    patch(r.participantId) { it.copy(status = if (live(r.participantId)) TxStatus.Transferring else TxStatus.Reconnecting) }
                }
                checkFinal()
            }
            e.type.startsWith("PARTICIPANT_") || e.type == "SESSION_UPDATED" || e.type == SocketEvent.OPEN -> refresh()
            e.type == "SESSION_CLOSED" || e.type == "SESSION_EXPIRED" -> {
                for (pid in peers.keys.toList()) drop(pid)
                for (r in s.receivers) {
                    if (!r.status.ended()) {
                        patch(r.participantId) {
                            it.copy(status = TxStatus.Cancelled, eta = null, bytesPerSecond = 0.0)
                        }
                    }
                }
                update { it.copy(ended = true) }
                checkFinal()
            }
        }
    }

    private suspend fun onOffer(pid: String, payload: SdpPayload) {
        if (s.receivers.none { it.participantId == pid && pid !in gone }) refresh()
        val r = s.receivers.firstOrNull { it.participantId == pid }
        if (r == null || pid in gone) return
        drop(pid)
        val servers = Rtc.iceServers(d.transfers, d.sessionId)
        val factory = withContext(Dispatchers.Main) { Rtc.factory(d.context) }
        lateinit var peer: Peer
        val observer =
            object : PeerObserver() {
                override fun onIceCandidate(candidate: IceCandidate) {
                    scope.launch {
                        val c = CandidatePayload(payload.conn, candidate.toJson())
                        signal("ICE_CANDIDATE", pid, d.json.encodeToJsonElement(CandidatePayload.serializer(), c).jsonObject)
                    }
                }

                override fun onDataChannel(channel: DataChannel) {
                    scope.launch {
                        if (channel.label() != CHANNEL_LABEL || peers[pid] !== peer) return@launch
                        lateinit var adapter: DataChannelAdapter
                        var served = false
                        adapter =
                            DataChannelAdapter(channel, scope) {
                                if (!served) {
                                    served = true
                                    serve(pid, peer, adapter)
                                }
                            }
                        peer.channel = adapter
                        if (adapter.isOpen && !served) {
                            served = true
                            serve(pid, peer, adapter)
                        }
                    }
                }

                override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                    scope.launch {
                        if (peers[pid] !== peer) return@launch
                        when (newState) {
                            PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> lostPeer(pid)
                            PeerConnection.PeerConnectionState.DISCONNECTED -> {
                                delay(4000)
                                if (peers[pid] === peer &&
                                    peer.pc.connectionState() == PeerConnection.PeerConnectionState.DISCONNECTED
                                ) {
                                    lostPeer(pid)
                                }
                            }
                            else -> Unit
                        }
                    }
                }
            }
        val pc = factory.createPeerConnection(Rtc.config(servers), observer) ?: return
        peer = Peer(pc, payload.conn, Throughput())
        peers[pid] = peer
        try {
            pc.setRemoteAwait(payload.sdp.toSdp())
            peer.ready = true
            pendingIce[pid]?.remove(payload.conn)?.forEach { runCatching { pc.addIceCandidate(it.toCandidate()) } }
            val answer = pc.createAnswerAwait()
            pc.setLocalAwait(answer)
            signal("ANSWER", pid, d.json.encodeToJsonElement(SdpPayload.serializer(), SdpPayload(payload.conn, answer.toJson())).jsonObject)
            if (r.status == TxStatus.Waiting) patch(pid) { it.copy(status = TxStatus.Connecting) }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            drop(pid)
        }
    }

    private fun signal(type: String, to: String, payload: JsonObject) = d.socket.send(
        buildJsonObject {
            put("type", type)
            put("session_id", d.sessionId)
            put("to", to)
            put("payload", payload)
        }
    )

    private fun serve(pid: String, peer: Peer, ch: DataChannelAdapter) {
        fun transfersOf() = list?.transfers.orEmpty().filter { it.participantId == pid }
        val files = senderFiles.map { f ->
            SenderFile(
                f.index,
                f.fileId,
                transfersOf().firstOrNull {
                    it.fileId == f.fileId
                }?.id.orEmpty(),
                f.name,
                f.size,
                f.mime,
                f.source
            )
        }
        lateinit var conn: SenderConnection
        conn =
            SenderConnection(
                SenderOptions(
                    channel = ch,
                    scope = scope,
                    sessionId = d.sessionId,
                    files = files,
                    hashes = hashes,
                    cache = cache,
                    unavailable = !s.hasFiles,
                    authorize = { participant, capability ->
                        if (participant != pid) return@SenderOptions false
                        var p = list?.peers?.firstOrNull { it.participantId == pid }
                        if (p?.capabilityHash == null) {
                            refresh()
                            p = list?.peers?.firstOrNull { it.participantId == pid }
                        }
                        p?.capabilityHash != null && p.status == "JOINED" && sha256(capability.toByteArray()).hex() == p.capabilityHash
                    },
                    events =
                    object : SenderEvents {
                        override fun onAuthorized(participantId: String) {
                            downTimers.remove(pid)?.cancel()
                            val paused =
                                SessionResult.statusFromServer(transfers.values.filter { it.participantId == pid }.map { it.status }) ==
                                    TxStatus.Paused
                            if (paused) conn.pause()
                            patch(pid) { it.copy(status = if (paused) TxStatus.Paused else TxStatus.Transferring, error = null) }
                        }

                        override fun onProgress(file: Int, verifiedBytes: Long) {
                            if (verifiedBytes > 0 && startedAt == null) startedAt = d.clock()
                            patch(pid) { cur ->
                                val perFile = cur.perFile.mapIndexed { i, n -> if (i == file) maxOf(n, verifiedBytes) else n }
                                cur.copy(
                                    perFile = perFile,
                                    verified = perFile.sum(),
                                    status = if (cur.status == TxStatus.Reconnecting ||
                                        cur.status == TxStatus.Connecting
                                    ) {
                                        TxStatus.Transferring
                                    } else {
                                        cur.status
                                    }
                                )
                            }
                        }

                        override fun onComplete() {
                            patch(pid) { it.copy(status = TxStatus.Completed) }
                            scope.launch { checkFinal() }
                        }

                        override fun onPaused(byPeer: Boolean) = patch(pid) { it.copy(status = TxStatus.Paused) }

                        override fun onResumed(byPeer: Boolean) = patch(pid) { it.copy(status = TxStatus.Transferring) }

                        override fun onError(code: String, fatal: Boolean, message: String?) = connError(pid, code, fatal)
                    }
                )
            )
        peer.conn = conn
        scope.launch {
            val route = peer.pc.selectedRoute() ?: return@launch
            patch(pid) { it.copy(route = route) }
        }
    }

    private fun connError(pid: String, code: String, fatal: Boolean) {
        val r = s.receivers.firstOrNull { it.participantId == pid } ?: return
        if (r.status.ended()) return
        if (code == ErrorCodes.CANCELLED) return patch(pid) { it.copy(status = TxStatus.Cancelled) }
        if (fatal) {
            val key =
                when (code) {
                    ErrorCodes.CHECKSUM_RETRIES, ErrorCodes.FILE_HASH_MISMATCH -> "product.tx_err_checksum"
                    ErrorCodes.UNAUTHORIZED -> "product.tx_err_unauthorized"
                    ErrorCodes.FILE_UNREADABLE -> "product.tx_err_sender_files"
                    else -> "product.tx_err_protocol"
                }
            return patch(pid) { it.copy(status = TxStatus.Failed, error = key) }
        }
        lostPeer(pid)
    }

    private fun hold(pid: String, conn: String, c: CandidateJson) {
        val byConn = pendingIce.getOrPut(pid) { LinkedHashMap() }
        val list = byConn.getOrPut(conn) { mutableListOf() }
        if (list.size < 50) list += c
        while (byConn.size > 2) byConn.remove(byConn.keys.first())
    }

    private fun lostPeer(pid: String) {
        peers[pid]?.let { p ->
            p.conn?.close()
            p.conn = null
        }
        val r = s.receivers.firstOrNull { it.participantId == pid }
        if (r?.route != null) patch(pid) { it.copy(route = null) }
        if (r == null || !r.status.active()) return
        patch(pid) { it.copy(status = TxStatus.Reconnecting, eta = null) }
    }

    private fun live(pid: String): Boolean {
        val p = peers[pid] ?: return false
        return p.conn != null && runCatching { p.pc.connectionState() == PeerConnection.PeerConnectionState.CONNECTED }.getOrDefault(false)
    }

    private fun sample() {
        val now = d.clock()
        for ((pid, p) in peers) {
            val r = s.receivers.firstOrNull { it.participantId == pid } ?: continue
            p.throughput.sample(r.verified, now)
            val (bps, eta) = p.throughput.estimate(r.verified, r.total, r.status == TxStatus.Reconnecting)
            if (bps != r.bytesPerSecond || eta != r.eta) patch(pid) { it.copy(bytesPerSecond = bps, eta = eta) }
        }
    }

    private suspend fun checkFinal() {
        val rs = s.receivers
        val all = transfers.values
        val inputs =
            rs.map { r ->
                val mine = all.filter { it.participantId == r.participantId }
                ResultInput(r.status, r.delivered, mine.count { it.status == "COMPLETED" }, maxOf(mine.size, s.files.size))
            }
        val final = SessionResult.of(inputs, s.ended)
        if (s.final != final) update { it.copy(final = final) }
        if (final == null || !s.hasFiles) return
        val key = listOf(final.name, rs.map { "${it.participantId}:${it.status}:${it.verified}" }).toString()
        if (key == historyKey) return
        historyKey = key
        val files = s.files
        val id = "tx:${d.sessionId}"
        val prev = runCatching { d.history.observe(id).first() }.getOrNull()
        val routes = rs.mapNotNull { it.route }.distinct()
        val route =
            when {
                routes.size > 1 -> HistoryRoute.MIXED
                routes.singleOrNull() == "relay" -> HistoryRoute.RELAY
                routes.singleOrNull() == "direct" -> HistoryRoute.DIRECT
                else -> prev?.route
            }
        val entry =
            HistoryEntry(
                id = id,
                direction = Direction.SENT,
                title = files.firstOrNull()?.name.orEmpty(),
                fileCount = files.size,
                totalBytes = files.sumOf { it.size },
                transferredBytes = maxOf(rs.maxOfOrNull { it.verified } ?: 0, prev?.transferredBytes ?: 0),
                peer = rs.joinToString(", ") { it.name },
                status =
                when (final) {
                    TxFinal.Completed -> HistoryStatus.COMPLETED
                    TxFinal.Partial -> HistoryStatus.PARTIAL
                    TxFinal.Failed -> HistoryStatus.FAILED
                    TxFinal.Cancelled -> HistoryStatus.CANCELLED
                },
                createdAt = prev?.createdAt ?: d.clock(),
                peers = rs.map { it.name },
                files =
                files.mapIndexed { i, f ->
                    HistoryFile(
                        f.name,
                        f.size,
                        maxOf(
                            rs.maxOfOrNull { it.perFile.getOrElse(f.index) { 0 } } ?: 0,
                            prev?.files?.getOrNull(i)?.transferredBytes ?: 0
                        )
                    )
                },
                route = route,
                startedAt = startedAt ?: prev?.startedAt
            )
        runCatching { d.history.add(entry) }
    }

    companion object {
        const val RECONNECT_WINDOW_MS = 10 * 60_000L

        /** Keeps only the known candidate fields with length checks (null when unusable). */
        fun sanitize(c: CandidateJson): CandidateJson? {
            if (c.candidate.isEmpty() || c.candidate.length > 1024) return null
            return CandidateJson(
                c.candidate,
                c.sdpMid?.takeIf { it.length <= 64 },
                c.sdpMLineIndex,
                c.usernameFragment?.takeIf {
                    it.length <=
                        256
                }
            )
        }
    }
}
