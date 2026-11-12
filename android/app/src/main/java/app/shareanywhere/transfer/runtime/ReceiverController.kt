package app.shareanywhere.transfer.runtime

import android.content.ContentResolver
import android.content.Context
import androidx.core.net.toUri
import app.shareanywhere.data.api.SessionView
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.data.api.TransfersApi
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.data.ws.SocketEvent
import app.shareanywhere.history.Direction
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryFile
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.history.HistoryRoute
import app.shareanywhere.history.HistoryStatus
import app.shareanywhere.transfer.IncomingDao
import app.shareanywhere.transfer.IncomingProgress
import app.shareanywhere.transfer.SaveTarget
import app.shareanywhere.transfer.engine.Bitmap
import app.shareanywhere.transfer.engine.Decision
import app.shareanywhere.transfer.engine.ErrorCodes
import app.shareanywhere.transfer.engine.FileMetaEntry
import app.shareanywhere.transfer.engine.HelloReceiver
import app.shareanywhere.transfer.engine.PolicyStep
import app.shareanywhere.transfer.engine.PreparedFile
import app.shareanywhere.transfer.engine.ProtocolException
import app.shareanywhere.transfer.engine.ReceiverConnection
import app.shareanywhere.transfer.engine.ReceiverEvents
import app.shareanywhere.transfer.engine.ReceiverOptions
import app.shareanywhere.transfer.engine.RouteKind
import app.shareanywhere.transfer.engine.RouteMonitor
import app.shareanywhere.transfer.engine.TransferChannel
import app.shareanywhere.transfer.engine.Wire
import app.shareanywhere.transfer.engine.hex
import app.shareanywhere.transfer.engine.sha256
import app.shareanywhere.transfer.rtc.CHANNEL_LABEL
import app.shareanywhere.transfer.rtc.CandidatePayload
import app.shareanywhere.transfer.rtc.DataChannelAdapter
import app.shareanywhere.transfer.rtc.Rtc
import app.shareanywhere.transfer.rtc.RtcTestHooks
import app.shareanywhere.transfer.rtc.SdpPayload
import app.shareanywhere.transfer.rtc.classify
import app.shareanywhere.transfer.rtc.createOfferAwait
import app.shareanywhere.transfer.rtc.setLocalAwait
import app.shareanywhere.transfer.rtc.setRemoteAwait
import app.shareanywhere.transfer.rtc.toCandidate
import app.shareanywhere.transfer.rtc.toJson
import app.shareanywhere.transfer.rtc.toSdp
import app.shareanywhere.transfer.storage.Folders
import app.shareanywhere.transfer.storage.SafSink
import java.util.UUID
import kotlin.math.min
import kotlin.math.pow
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
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection

enum class RxPhase {
    Loading,
    Choose,
    Connecting,
    Transferring,
    Paused,
    Reconnecting,
    Verifying,
    Completed,
    Partial,
    Failed,
    Cancelled,
    Unreachable
}

fun RxPhase.active() =
    this == RxPhase.Connecting || this == RxPhase.Transferring || this == RxPhase.Reconnecting || this == RxPhase.Verifying

fun RxPhase.final() = this == RxPhase.Completed || this == RxPhase.Partial || this == RxPhase.Failed || this == RxPhase.Cancelled

data class RxFile(
    val index: Int,
    val fileId: String,
    val transferId: String,
    val name: String,
    val size: Long,
    val mime: String,
    val verified: Long,
    val done: Boolean,
    val failed: Boolean,
    val documentUri: String? = null
)

data class RxState(
    val phase: RxPhase = RxPhase.Loading,
    val files: List<RxFile> = emptyList(),
    val total: Long = 0,
    val verified: Long = 0,
    val route: String? = null,
    /** What the connection runs over in detail (direct, relay over UDP, TCP or TLS); null until known. */
    val routeKind: RouteKind? = null,
    /** The server refused TURN credentials because this session reached its relay byte cap. */
    val relayCapped: Boolean = false,
    val bytesPerSecond: Double = 0.0,
    val eta: Long? = null,
    /** Catalog error key when failed (product.tx_err_*). */
    val error: String? = null,
    val target: SaveTarget? = null,
    val words: List<String> = emptyList(),
    val senderName: String = "",
    val duplicates: Int = 0,
    val resumedBytes: Long = 0
)

/** Dependencies of a receive; the runtime builds them once per session. */
class ReceiverDeps(
    val context: Context,
    val sessionId: String,
    val sessions: SessionsApi,
    val transfers: TransfersApi,
    val socket: SessionSocket,
    val incoming: IncomingDao,
    val history: HistoryRepository,
    val json: Json,
    val clock: () -> Long = System::currentTimeMillis,
    val random: () -> Double = Math::random
)

/**
 * Drives one receive (docs/TRANSFER_PROTOCOL.md), the Android twin of the Web's ReceiverController: the folder the
 * user chose, the peer connection (the receiver offers), the persisted bitmap for resume, state reports, reconnects
 * within the 2/10-minute windows, and the local History entry. All state lives on one confined dispatcher.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ReceiverController(private val d: ReceiverDeps) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
    private val _state = MutableStateFlow(RxState())
    val state: StateFlow<RxState> = _state.asStateFlow()
    private val s get() = _state.value
    private val resolver: ContentResolver = d.context.contentResolver
    private val reporter = Reporter(TransfersReportSink(d.transfers), scope, now = d.clock)
    private var capability = ""
    private var capHash = ""
    private var senderPid = ""
    private var participantId = ""
    private var pc: PeerConnection? = null
    private var channel: DataChannelAdapter? = null
    private var conn: ReceiverConnection? = null
    private var connId = ""
    private var attempt = 0
    private var retryJob: Job? = null
    private var openJob: Job? = null
    private var samplerJob: Job? = null

    /** Route strategy: which ICE policy step to dial on, and when to move one step stricter (ARCHITECTURE §6). */
    private val routeMonitor = RouteMonitor(RtcTestHooks.routeStep ?: PolicyStep.ALL)
    private var routeJob: Job? = null

    /** When the current TURN credential expires; a relayed connection is renewed before then. */
    private var credExpiresAt: Long? = null

    /** Debug builds only (instrumentation tests): drop frames over a direct connection, as if that path stopped working. */
    @Volatile var testBlockDirect = false
        set(v) {
            field = v && app.shareanywhere.BuildConfig.DEBUG
        }
    private var socketJob: Job? = null
    private val sinks = HashMap<Int, SafSink>()
    private val throughput = Throughput()
    private var stopped = false
    private var hadData = false
    private var historyWritten = false
    private var startedAt: Long? = null
    private var downSince: Long? = null
    private var everOpened = false
    private var loaded: Job? = null
    private val fileWork = Mutex()

    init {
        // Out of PAUSED only through the resume action; stay paused when the user (or the sender) paused.
        reporter.resume = { id ->
            if (s.phase ==
                RxPhase.Paused
            ) {
                null
            } else {
                runCatching { d.transfers.action(id, TransfersApi.Action.Resume, capability).status }.getOrNull()
            }
        }
    }

    private fun update(f: (RxState) -> RxState) = _state.update(f)

    private fun open() = s.files.filter { !it.done && !it.failed }

    /** Loads the session, records and saved progress; resumes when a folder is already chosen. */
    fun init() {
        if (loaded != null) return
        loaded =
            scope.launch {
                runCatching { load() }.onFailure { update { it.copy(phase = RxPhase.Failed, error = "product.error_generic") } }
            }
    }

    private suspend fun load() {
        val view: SessionView = d.sessions.get(d.sessionId)
        val list = d.transfers.list(d.sessionId)
        senderPid = view.sender?.participantId.orEmpty()
        participantId = view.me?.id.orEmpty()
        capability = list.capability.orEmpty()
        capHash = sha256(capability.toByteArray()).hex()
        val byFile = list.transfers.associateBy { it.fileId }
        val files =
            view.files.orEmpty().mapIndexedNotNull { index, f ->
                val t = byFile[f.id] ?: return@mapIndexedNotNull null
                reporter.seed(t.id, t.status, t.verifiedBytes)
                val saved = d.incoming.get(key(t.id))
                RxFile(
                    index, f.id, t.id, f.name, f.size, f.mime,
                    verified = saved?.let { verifiedOf(it) } ?: 0,
                    done = t.status == "COMPLETED" || saved?.verified == true,
                    failed = t.status == "FAILED" || t.status == "CANCELLED",
                    documentUri = saved?.documentUri
                )
            }
        update {
            it.copy(
                words = view.me?.securityWords.orEmpty(),
                senderName = view.sender?.displayName.orEmpty(),
                files = files,
                total = files.sumOf { f -> f.size },
                verified = sum(files),
                resumedBytes = files.filter { f -> !f.done }.sumOf { f -> f.verified }
            )
        }
        socketJob = scope.launch { d.socket.subscribe().collect { onSocket(it) } }
        val statuses = list.transfers.map { it.status }
        if (statuses.isNotEmpty() && statuses.all { it == "COMPLETED" }) return finish(RxPhase.Completed)
        if (statuses.isNotEmpty() &&
            statuses.all { Transitions.terminal(it) }
        ) {
            return finish(if ("COMPLETED" in statuses) RxPhase.Partial else RxPhase.Cancelled)
        }
        val target = d.incoming.target(d.sessionId) ?: return update { it.copy(phase = RxPhase.Choose) }
        update { it.copy(target = target) }
        if ("PAUSED" in statuses) return update { it.copy(phase = RxPhase.Paused) }
        connect()
    }

    /** RX-5b: the user chose a folder (OpenDocumentTree, persisted grant). */
    fun start(target: SaveTarget) = scope.launch {
        loaded?.join()
        d.incoming.putTarget(target)
        update { it.copy(target = target) }
        if (open().any { reporter.current(it.transferId) == "PAUSED" }) return@launch update { it.copy(phase = RxPhase.Paused) }
        connect()
    }

    fun pause() = scope.launch {
        val p = s.phase
        if (p.final() || p == RxPhase.Paused || p == RxPhase.Unreachable || p == RxPhase.Verifying) return@launch
        retryJob?.cancel()
        retryJob = null
        val c = conn
        if (c != null) c.pause() else teardown()
        update { it.copy(phase = RxPhase.Paused, eta = null) }
        for (f in open()) {
            runCatching {
                d.transfers.action(f.transferId, TransfersApi.Action.Pause)
            }.getOrNull()?.let { reporter.seed(f.transferId, it.status, it.verifiedBytes) }
        }
    }

    fun resume() = scope.launch {
        if (s.phase != RxPhase.Paused) return@launch
        for (f in open()) {
            runCatching {
                d.transfers.action(f.transferId, TransfersApi.Action.Resume, capability)
            }.getOrNull()?.let { reporter.seed(f.transferId, it.status, it.verifiedBytes) }
        }
        val c = conn
        if (c != null && pc?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) {
            c.resume()
            update { it.copy(phase = RxPhase.Transferring) }
            for (f in open()) scope.launch { reporter.state(f.transferId, "TRANSFERRING", f.verified) }
        } else {
            update { it.copy(phase = RxPhase.Connecting) }
            attempt = 0
            downSince = null
            connect()
        }
    }

    /** After the reconnect window ran out: a new window. */
    fun retry() = scope.launch {
        if (s.phase != RxPhase.Unreachable) return@launch
        attempt = 0
        downSince = null
        connect()
    }

    fun cancel() = scope.launch {
        conn?.cancel()
        for (f in open()) runCatching { d.transfers.action(f.transferId, TransfersApi.Action.Cancel) }
        cleanup(keepDone = true)
        finish(RxPhase.Cancelled)
    }

    /** Removed, blocked, left, or the session ended: stop and keep only finished files. */
    fun endedElsewhere() = scope.launch {
        if (s.phase.final()) return@launch
        teardown()
        cleanup(keepDone = true)
        val files = s.files
        finish(
            if (files.all { it.done }) {
                RxPhase.Completed
            } else if (files.any { it.done }) {
                RxPhase.Partial
            } else {
                RxPhase.Cancelled
            }
        )
    }

    fun dispose() {
        stopped = true
        scope.launch {
            teardown()
            reporter.dispose()
            socketJob?.cancel()
            sinks.values.forEach { it.close() }
            scope.cancel()
        }
    }

    // --- connection ---

    private suspend fun connect() {
        if (stopped || s.phase.final() || s.phase == RxPhase.Paused) return
        teardown()
        if (downSince == null) downSince = d.clock()
        val reconnecting = hadData || attempt > 0
        update { it.copy(phase = if (reconnecting) RxPhase.Reconnecting else RxPhase.Connecting) }
        for (f in open()) scope.launch { reporter.state(f.transferId, if (reconnecting) "RECONNECTING" else "CONNECTING", f.verified) }
        dial()
    }

    private suspend fun dial() {
        val id = UUID.randomUUID().toString()
        connId = id
        val setup = Rtc.setup(d.transfers, d.sessionId, routeMonitor.step)
        if (connId != id || stopped) return
        credExpiresAt = setup.expiresAt
        val capped = setup.turnRefused == "relay_cap_reached"
        if (capped != s.relayCapped) update { it.copy(relayCapped = capped) }
        val factory = withContext(Dispatchers.Main) { Rtc.factory(d.context) }
        lateinit var peer: PeerConnection
        val observer =
            object : PeerObserver() {
                override fun onIceCandidate(candidate: IceCandidate) {
                    scope.launch {
                        sendSignal(
                            "ICE_CANDIDATE",
                            d.json.encodeToJsonElement(CandidatePayload.serializer(), CandidatePayload(id, candidate.toJson())).jsonObject
                        )
                    }
                }

                override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                    scope.launch {
                        if (pc !== peer) return@launch
                        when (newState) {
                            PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> lost()
                            PeerConnection.PeerConnectionState.DISCONNECTED -> {
                                delay(4000)
                                if (pc === peer && peer.connectionState() == PeerConnection.PeerConnectionState.DISCONNECTED) lost()
                            }
                            else -> Unit
                        }
                    }
                }
            }
        peer = factory.createPeerConnection(Rtc.config(setup.servers, setup.relayOnly), observer) ?: return lost()
        pc = peer
        val dc = peer.createDataChannel(CHANNEL_LABEL, DataChannel.Init().apply { ordered = true })
        lateinit var adapter: DataChannelAdapter
        adapter =
            DataChannelAdapter(dc, scope) {
                if (pc !== peer) return@DataChannelAdapter
                openJob?.cancel()
                downSince = null
                everOpened = true
                attach(adapter, peer)
            }
        channel = adapter
        openJob =
            scope.launch {
                delay(20_000)
                if (pc === peer && conn == null) lost()
            }
        try {
            val offer = peer.createOfferAwait()
            peer.setLocalAwait(offer)
            val payload = SdpPayload(id, offer.toJson())
            if (!sendSignal("OFFER", d.json.encodeToJsonElement(SdpPayload.serializer(), payload).jsonObject)) lost()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            lost()
        }
    }

    private fun sendSignal(type: String, payload: JsonObject): Boolean = d.socket.send(
        buildJsonObject {
            put("type", type)
            put("session_id", d.sessionId)
            put("to", senderPid)
            put("payload", payload)
        }
    )

    private fun attach(ch: DataChannelAdapter, peer: PeerConnection) {
        val c =
            ReceiverConnection(
                ReceiverOptions(
                    channel = GatedChannel(ch) { testBlockDirect && s.routeKind == RouteKind.DIRECT },
                    scope = scope,
                    hello = HelloReceiver(sessionId = d.sessionId, participantId = participantId, capability = capability),
                    prepare = { prepare(it) },
                    events =
                    object : ReceiverEvents {
                        override fun onProgress(file: Int, verifiedBytes: Long) = onFileProgress(file, verifiedBytes)

                        override fun onVerifying(file: Int, hashedBytes: Long) {
                            if (s.phase != RxPhase.Paused) update { it.copy(phase = RxPhase.Verifying) }
                        }

                        // Per-file completion and the final result run one after another, in order (the Web's
                        // fileWork chain): the result must see every file marked done.
                        override fun onFileDone(file: Int, ok: Boolean) {
                            scope.launch { fileWork.withLock { fileDone(file, ok) } }
                        }

                        override fun onComplete() {
                            scope.launch { fileWork.withLock { allDone() } }
                        }

                        override fun onPaused(byPeer: Boolean) = update { it.copy(phase = RxPhase.Paused) }

                        override fun onResumed(byPeer: Boolean) = update { it.copy(phase = RxPhase.Transferring) }

                        override fun onError(code: String, fatal: Boolean, message: String?) {
                            // The error code only: messages can carry file paths or a peer's text.
                            android.util.Log.w("SA-TRANSFER", "receiver error code=$code fatal=$fatal")
                            scope.launch { connError(code, fatal) }
                        }
                    }
                )
            )
        conn = c
        c.start()
        if (s.phase == RxPhase.Paused) c.pause()
        samplerJob =
            scope.launch {
                while (isActive) {
                    delay(500)
                    sample()
                }
            }
        routeMonitor.rebase(s.verified, d.clock())
        update { it.copy(routeKind = null) }
        routeJob =
            scope.launch {
                while (isActive && pc === peer) {
                    routeTick(peer, ch)
                    delay(2000)
                }
            }
    }

    /**
     * Every 2 s on an open channel: classify the selected pair (badge and report), feed the route monitor, and migrate
     * one policy step stricter on a sustained stall; a relayed connection is renewed before its TURN credential
     * expires (a new connection on the same step fetches a fresh one). As the Web's routeTick.
     */
    private suspend fun routeTick(peer: PeerConnection, ch: DataChannelAdapter) {
        val c = peer.classify()
        if (pc !== peer) return
        val now = d.clock()
        val kind = c.kind
        if (kind != null && kind != s.routeKind) {
            reporter.route = kind.serverRoute
            update { it.copy(route = kind.serverRoute, routeKind = kind) }
        }
        if (s.phase == RxPhase.Paused) return routeMonitor.rebase(s.verified, now)
        // Migration tears this connection down, which cancels the route loop running this tick: run it on its own.
        if (routeMonitor.sample(ch.isOpen, s.verified, c.rttMs, now) == Decision.MIGRATE) {
            scope.launch { migrate() }
            return
        }
        val expires = credExpiresAt
        if (kind != null && kind != RouteKind.DIRECT && expires != null && now > expires - 120_000) scope.launch { migrate(renew = true) }
    }

    /** Moves to a new connection: one policy step stricter, or ([renew]) the same step with a fresh credential. */
    private suspend fun migrate(renew: Boolean = false) {
        if (stopped || s.phase.final()) return
        android.util.Log.i("SA-TRANSFER", if (renew) "route renew" else "route migrate to ${routeMonitor.step.wire}")
        for (f in open()) scope.launch { reporter.state(f.transferId, "DISCONNECTED", f.verified) }
        connect()
    }

    private suspend fun prepare(e: FileMetaEntry): PreparedFile {
        val f = s.files.firstOrNull { it.transferId == e.transferId }
        // FILE_META must describe exactly the files the server announced.
        if (f == null || f.fileId != e.fileId || f.size != e.size) throw ProtocolException("FILE_META does not match the session’s files")
        val target = s.target ?: throw ProtocolException("no folder chosen")
        val k = key(f.transferId)
        val saved = d.incoming.get(k)?.takeIf {
            it.blockSize == e.blockSize &&
                it.size == e.size &&
                Folders.exists(resolver, it.documentUri.toUri())
        }
        val base =
            saved ?: run {
                val doc = withContext(Dispatchers.IO) { Folders.create(resolver, target.treeUri, f.name, f.mime) }
                IncomingProgress(
                    k, d.sessionId, f.transferId, f.name, e.size, e.blockSize,
                    Bitmap(
                        e.blockCount
                    ).bytes,
                    doc.toString(), false, d.clock()
                )
                    .also { d.incoming.put(it) }
            }
        val sink = sinks.getOrPut(f.index) { SafSink(resolver, base.documentUri.toUri()) }
        update { st -> st.copy(files = st.files.map { if (it.index == f.index) it.copy(documentUri = base.documentUri) else it }) }
        var current = base
        return PreparedFile(sink, Bitmap(e.blockCount, base.bitmap), persist = { bm ->
            current = current.copy(bitmap = bm.bytes.copyOf(), updatedAt = d.clock())
            d.incoming.put(current)
        }, verified = base.verified)
    }

    private fun onFileProgress(file: Int, bytes: Long) {
        val f = s.files.firstOrNull { it.index == file } ?: return
        if (bytes > f.verified && startedAt == null) startedAt = d.clock()
        val files = s.files.map { if (it.index == file) it.copy(verified = bytes) else it }
        val phase = if (s.phase ==
            RxPhase.Paused
        ) {
            RxPhase.Paused
        } else if (s.phase == RxPhase.Verifying) {
            RxPhase.Verifying
        } else {
            RxPhase.Transferring
        }
        if (phase == RxPhase.Transferring && s.phase != RxPhase.Transferring) {
            for (x in files.filter { !it.done && !it.failed }) scope.launch { reporter.state(x.transferId, "TRANSFERRING", x.verified) }
        }
        hadData = hadData || bytes > 0
        attempt = 0
        update { it.copy(files = files, verified = sum(files), phase = phase) }
        if (!f.done) reporter.progress(f.transferId, bytes)
    }

    private suspend fun fileDone(file: Int, ok: Boolean) {
        val f = s.files.firstOrNull { it.index == file } ?: return
        if (!ok) {
            update { st -> st.copy(files = st.files.map { if (it.index == file) it.copy(failed = true) else it }) }
            reporter.state(f.transferId, "FAILED", f.verified)
            return
        }
        d.incoming.get(key(f.transferId))?.let {
            d.incoming.put(it.copy(verified = true, updatedAt = d.clock()))
            withContext(Dispatchers.IO) { Folders.finish(resolver, it.documentUri.toUri()) }
        }
        sinks.remove(f.index)?.close()
        update { st -> st.copy(files = st.files.map { if (it.index == file) it.copy(done = true, verified = it.size) else it }) }
        reporter.state(f.transferId, "COMPLETED", f.size)
    }

    private fun allDone() {
        val files = s.files
        finish(
            if (files.all { it.done }) {
                RxPhase.Completed
            } else if (files.any { it.done }) {
                RxPhase.Partial
            } else {
                RxPhase.Failed
            }
        )
        teardown()
    }

    private suspend fun connError(code: String, fatal: Boolean) {
        if (stopped || s.phase.final()) return
        if (code == ErrorCodes.CANCELLED) {
            cleanup(keepDone = true)
            return finish(RxPhase.Cancelled)
        }
        if (fatal) {
            for (f in open()) scope.launch { reporter.state(f.transferId, "FAILED", f.verified) }
            cleanup(keepDone = true)
            update { it.copy(error = ERROR_KEYS[code] ?: "product.tx_err_protocol") }
            return finish(if (s.files.any { it.done }) RxPhase.Partial else RxPhase.Failed)
        }
        lost()
    }

    /** The channel dropped or never opened: DISCONNECTED, then redial with jittered backoff (1 s doubling to 15 s). */
    private fun lost() {
        if (stopped || s.phase.final() || retryJob?.isActive == true) return
        val paused = s.phase == RxPhase.Paused
        teardown()
        update { it.copy(route = null, routeKind = null) }
        for (f in open()) scope.launch { reporter.state(f.transferId, if (paused) "PAUSED" else "DISCONNECTED", f.verified) }
        if (paused) return
        val window = if (everOpened) 10 * 60_000L else 2 * 60_000L
        val since = downSince
        if (since != null && d.clock() - since > window) return update { it.copy(phase = RxPhase.Unreachable, eta = null) }
        update { it.copy(phase = RxPhase.Reconnecting) }
        // Repeated losses on one policy step move the next dial one step stricter, at once.
        val escalate = routeMonitor.lost(d.clock()) == Decision.MIGRATE
        if (escalate) android.util.Log.i("SA-TRANSFER", "route migrate to ${routeMonitor.step.wire} after losses")
        val wait = if (escalate) 0L else redialDelay(attempt++, d.random)
        retryJob =
            scope.launch {
                delay(wait)
                retryJob = null
                connect()
            }
    }

    private fun teardown() {
        openJob?.cancel()
        samplerJob?.cancel()
        routeJob?.cancel()
        openJob = null
        samplerJob = null
        routeJob = null
        conn?.let { c -> update { it.copy(duplicates = it.duplicates + c.counters.duplicates) } }
        conn = null
        val ch = channel
        val peer = pc
        channel = null
        pc = null
        connId = ""
        ch?.dispose()
        runCatching { peer?.dispose() }
    }

    private suspend fun onSocket(e: SocketEvent) {
        val payload = e.body["payload"] as? JsonObject
        val from = e.body["from"]?.jsonPrimitive?.contentOrNull
        val conn = payload?.get("conn")?.jsonPrimitive?.contentOrNull
        val peer = pc
        when {
            e.type == "ANSWER" && from == senderPid && conn == connId && peer != null -> {
                val sdp = runCatching { d.json.decodeFromJsonElement(SdpPayload.serializer(), payload) }.getOrNull() ?: return
                try {
                    peer.setRemoteAwait(sdp.sdp.toSdp())
                } catch (ce: kotlinx.coroutines.CancellationException) {
                    throw ce
                } catch (_: Exception) {
                    lost()
                }
            }
            e.type == "ICE_CANDIDATE" && from == senderPid && conn == connId && peer != null -> {
                val c =
                    runCatching { d.json.decodeFromJsonElement(CandidatePayload.serializer(), payload) }.getOrNull()?.candidate ?: return
                runCatching { peer.addIceCandidate(c.toCandidate()) }
            }
            e.type == "TRANSFER_UPDATED" -> {
                val t = e.body["transfer"] as? JsonObject ?: return
                val id = t["id"]?.jsonPrimitive?.contentOrNull ?: return
                val status = t["status"]?.jsonPrimitive?.contentOrNull ?: return
                onServerUpdate(id, status, t["verified_bytes"]?.jsonPrimitive?.longOrNull ?: 0)
            }
            e.type == "SESSION_CLOSED" || e.type == "SESSION_EXPIRED" -> if (!s.phase.final()) endedElsewhere()
            e.type == "ERROR" && e.body["code"]?.jsonPrimitive?.contentOrNull == "peer_offline" && peer != null -> lost()
        }
    }

    /** The sender paused, resumed or cancelled through the server (works while the channel is down too). */
    private suspend fun onServerUpdate(id: String, status: String, verified: Long) {
        if (s.files.none { it.transferId == id }) return
        reporter.seed(id, status, verified)
        if (status == "PAUSED" && (s.phase.active() || s.phase == RxPhase.Unreachable)) {
            retryJob?.cancel()
            retryJob = null
            update { it.copy(phase = RxPhase.Paused, eta = null) }
        }
        if (status == "RESUMING" && s.phase == RxPhase.Paused) {
            if (conn != null && pc?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) {
                update { it.copy(phase = RxPhase.Transferring) }
            } else {
                update { it.copy(phase = RxPhase.Connecting) }
                connect()
            }
        }
        if (status == "CANCELLED" && !s.phase.final()) {
            conn?.close()
            cleanup(keepDone = true)
            finish(RxPhase.Cancelled)
        }
    }

    private fun sample() {
        val now = d.clock()
        throughput.sample(s.verified, now)
        val (bps, eta) = throughput.estimate(s.verified, s.total, s.phase == RxPhase.Reconnecting)
        update { it.copy(bytesPerSecond = bps, eta = eta) }
    }

    /** Removes unfinished documents and their bitmaps (a bitmap without its file would resume into a hash mismatch). */
    private suspend fun cleanup(keepDone: Boolean) = withContext(Dispatchers.IO) {
        for (f in s.files) {
            if (keepDone && f.done) continue
            sinks.remove(f.index)?.close()
            d.incoming.get(key(f.transferId))?.let { Folders.delete(resolver, it.documentUri.toUri()) }
            d.incoming.remove(key(f.transferId))
        }
    }

    private fun finish(phase: RxPhase) {
        retryJob?.cancel()
        retryJob = null
        update { it.copy(phase = phase, eta = null) }
        if (historyWritten || s.files.isEmpty()) return
        historyWritten = true
        val files = s.files
        val status =
            when (phase) {
                RxPhase.Completed -> HistoryStatus.COMPLETED
                RxPhase.Partial -> HistoryStatus.PARTIAL
                RxPhase.Cancelled -> HistoryStatus.CANCELLED
                else -> HistoryStatus.FAILED
            }
        val entry =
            HistoryEntry(
                id = "rx:${d.sessionId}",
                direction = Direction.RECEIVED,
                title = files.first().name,
                fileCount = files.size,
                totalBytes = s.total,
                transferredBytes = sum(files),
                peer = s.senderName,
                status = status,
                createdAt = d.clock(),
                peers = listOf(s.senderName).filter { it.isNotEmpty() },
                files = files.map { HistoryFile(it.name, it.size, if (it.done) it.size else it.verified) },
                route = s.route?.let { if (it == "relay") HistoryRoute.RELAY else HistoryRoute.DIRECT },
                startedAt = startedAt
            )
        scope.launch { runCatching { d.history.add(entry) } }
    }

    private fun key(transferId: String) = "$capHash:$transferId"

    private fun verifiedOf(p: IncomingProgress): Long {
        val bm = Bitmap(Wire.blockCount(p.size, p.blockSize), p.bitmap)
        var n = 0L
        for (i in 0 until bm.size) if (bm.has(i)) n += Wire.blockLength(p.size, i, p.blockSize)
        return n
    }

    companion object {
        val ERROR_KEYS =
            mapOf(
                ErrorCodes.UNAUTHORIZED to "product.tx_err_unauthorized",
                ErrorCodes.STORAGE_FULL to "product.tx_err_storage_full",
                ErrorCodes.STORAGE_ERROR to "product.tx_err_storage",
                ErrorCodes.FILE_UNREADABLE to "product.tx_err_sender_files",
                ErrorCodes.CHECKSUM_RETRIES to "product.tx_err_checksum",
                ErrorCodes.FILE_HASH_MISMATCH to "product.tx_err_checksum",
                ErrorCodes.PROTOCOL to "product.tx_err_protocol"
            )

        /** Redial delay: 1 s doubling to 15 s, ±25 % jitter (docs/TRANSFER_PROTOCOL.md §6). */
        fun redialDelay(attempt: Int, random: () -> Double = Math::random): Long =
            (min(15_000.0, 1000.0 * 2.0.pow(attempt.coerceAtMost(10))) * (0.75 + random() * 0.5)).toLong()

        private fun sum(files: List<RxFile>) = files.sumOf { if (it.done) it.size else it.verified }
    }
}

/** Reports go to POST /v1/transfers/{id}/report. */
class TransfersReportSink(private val api: TransfersApi) : ReportSink {
    override suspend fun report(transferId: String, status: String, verifiedBytes: Long, route: String?): String =
        api.report(transferId, status, verifiedBytes, route).status
}

/** Passes everything through, but drops incoming messages while [drop] says so (the testBlockDirect hook). */
private class GatedChannel(private val inner: TransferChannel, private val drop: () -> Boolean) : TransferChannel by inner {
    override fun setListener(listener: TransferChannel.Listener?) {
        inner.setListener(
            listener?.let { l ->
                object : TransferChannel.Listener by l {
                    override fun onMessage(data: ByteArray) {
                        if (!drop()) l.onMessage(data)
                    }
                }
            }
        )
    }
}
