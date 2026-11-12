package app.shareanywhere.transfer.rtc

import android.content.Context
import app.shareanywhere.data.api.TransfersApi
import app.shareanywhere.transfer.engine.Classified
import app.shareanywhere.transfer.engine.PolicyStep
import app.shareanywhere.transfer.engine.RouteClassifier
import app.shareanywhere.transfer.engine.StatsEntry
import app.shareanywhere.transfer.engine.TransferChannel
import app.shareanywhere.transfer.engine.urisForStep
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/** The data channel label of protocol version 1 (docs/TRANSFER_PROTOCOL.md §1). */
const val CHANNEL_LABEL = "sa-transfer/1"

/** Signaling payloads, the same JSON as the Web's RTCSessionDescriptionInit / RTCIceCandidateInit. */
@Serializable
data class SdpJson(val type: String, val sdp: String)

@Serializable
data class CandidateJson(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
    val usernameFragment: String? = null
)

@Serializable
data class SdpPayload(val conn: String, val sdp: SdpJson)

@Serializable
data class CandidatePayload(val conn: String, val candidate: CandidateJson? = null)

fun SessionDescription.toJson() = SdpJson(type.canonicalForm(), description)

fun SdpJson.toSdp() = SessionDescription(SessionDescription.Type.fromCanonicalForm(type), sdp)

fun IceCandidate.toJson() = CandidateJson(sdp, sdpMid, sdpMLineIndex)

fun CandidateJson.toCandidate() = IceCandidate(sdpMid ?: "0", sdpMLineIndex ?: 0, candidate)

/** One PeerConnectionFactory per process (libwebrtc initialisation is global). */
object Rtc {
    @Volatile private var factory: PeerConnectionFactory? = null

    fun factory(context: Context): PeerConnectionFactory = factory ?: synchronized(this) {
        factory ?: run {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions()
            )
            PeerConnectionFactory.builder().createPeerConnectionFactory().also { factory = it }
        }
    }

    /**
     * ICE configuration for a session on a policy step (docs/ARCHITECTURE.md §6), as the Web's rtcSetup: the TURN
     * credentials (only the step's URIs) plus a `stun:` URI on the same host and port on the first step; any step but
     * ALL is relay-only. Without credentials, direct candidates may still connect; [RtcSetup.turnRefused] says why.
     */
    suspend fun setup(api: TransfersApi, sessionId: String, step: PolicyStep = PolicyStep.ALL): RtcSetup {
        val relayOnly = step != PolicyStep.ALL || RtcTestHooks.relayOnly
        return try {
            val c = api.turn(sessionId)
            val uris = urisForStep(c.uris, step).map(RtcTestHooks::rewrite)
            val stun =
                c.uris
                    .filter { it.startsWith("turn:") }
                    .map { RtcTestHooks.rewrite(it).replaceFirst("turn:", "stun:").substringBefore('?') }
                    .distinct()
            val servers =
                buildList {
                    if (stun.isNotEmpty() && step == PolicyStep.ALL) add(PeerConnection.IceServer.builder(stun).createIceServer())
                    if (uris.isNotEmpty()) {
                        val b = PeerConnection.IceServer.builder(uris).setUsername(c.username).setPassword(c.credential)
                        if (RtcTestHooks.insecureTls) b.setTlsCertPolicy(PeerConnection.TlsCertPolicy.TLS_CERT_POLICY_INSECURE_NO_CHECK)
                        add(b.createIceServer())
                    }
                }
            RtcSetup(servers, relayOnly, null, runCatching { java.time.Instant.parse(c.expiresAt).toEpochMilli() }.getOrNull())
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            RtcSetup(emptyList(), relayOnly, (e as? app.shareanywhere.data.api.ApiException)?.code ?: "network", null)
        }
    }

    /** The ICE servers alone (the sender answers on whatever route the receiver offers). */
    suspend fun iceServers(api: TransfersApi, sessionId: String): List<PeerConnection.IceServer> = setup(api, sessionId).servers

    fun config(servers: List<PeerConnection.IceServer>, relayOnly: Boolean = RtcTestHooks.relayOnly) =
        PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
            if (relayOnly) iceTransportsType = PeerConnection.IceTransportsType.RELAY
        }
}

/** The result of [Rtc.setup]. */
data class RtcSetup(
    val servers: List<PeerConnection.IceServer>,
    val relayOnly: Boolean,
    /** The server refused TURN credentials (`relay_cap_reached`, `rate_limited`, …); null when issued. */
    val turnRefused: String?,
    /** When the TURN credential expires (ms since epoch), for renewal before a relayed connection loses it. */
    val expiresAt: Long?
)

/**
 * Debug builds only, set by instrumentation tests (docs/TESTING_AND_CI.md §5, ADR 0029): relay-only ICE, the policy
 * step a receiver starts on, the CI coturn's self-signed TLS certificate accepted, and the CI TURN host (127.0.0.1)
 * rewritten to the emulator's alias for the host (10.0.2.2). Release builds ignore every field.
 */
object RtcTestHooks {
    @Volatile var relayOnly = false
        get() = field && app.shareanywhere.BuildConfig.DEBUG

    @Volatile var routeStep: PolicyStep? = null
        get() = field?.takeIf { app.shareanywhere.BuildConfig.DEBUG }

    @Volatile var insecureTls = false
        get() = field && app.shareanywhere.BuildConfig.DEBUG

    /** Host to put in place of 127.0.0.1 in TURN URIs (the emulator reaches the host's loopback as 10.0.2.2). */
    @Volatile var turnHost: String? = null
        get() = field?.takeIf { app.shareanywhere.BuildConfig.DEBUG }

    fun rewrite(uri: String): String = turnHost?.let { uri.replace("127.0.0.1", it) } ?: uri

    fun reset() {
        relayOnly = false
        routeStep = null
        insecureTls = false
        turnHost = null
    }
}

/** createOffer / createAnswer / setLocal / setRemote as suspending calls. */
suspend fun PeerConnection.createOfferAwait(): SessionDescription = suspendCancellableCoroutine { c ->
    createOffer(sdpObserver(onCreate = { c.resume(it) }, onFail = { c.cancel(IllegalStateException(it)) }), MediaConstraints())
}

suspend fun PeerConnection.createAnswerAwait(): SessionDescription = suspendCancellableCoroutine { c ->
    createAnswer(sdpObserver(onCreate = { c.resume(it) }, onFail = { c.cancel(IllegalStateException(it)) }), MediaConstraints())
}

suspend fun PeerConnection.setLocalAwait(sdp: SessionDescription) = suspendCancellableCoroutine { c ->
    setLocalDescription(sdpObserver(onSet = { c.resume(Unit) }, onFail = { c.cancel(IllegalStateException(it)) }), sdp)
}

suspend fun PeerConnection.setRemoteAwait(sdp: SessionDescription) = suspendCancellableCoroutine { c ->
    setRemoteDescription(sdpObserver(onSet = { c.resume(Unit) }, onFail = { c.cancel(IllegalStateException(it)) }), sdp)
}

private fun sdpObserver(
    onCreate: (SessionDescription) -> Unit = {
    },
    onSet: () -> Unit = {},
    onFail: (String?) -> Unit
) = object : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) = onCreate(sdp)

    override fun onSetSuccess() = onSet()

    override fun onCreateFailure(error: String?) = onFail(error)

    override fun onSetFailure(error: String?) = onFail(error)
}

/** Classifies the selected candidate pair (docs/ARCHITECTURE.md §6): null fields until one is selected. */
suspend fun PeerConnection.classify(): Classified = suspendCancellableCoroutine { c ->
    getStats { report ->
        val entries =
            report.statsMap.values.map { st ->
                val m = st.members
                StatsEntry(
                    type = st.type,
                    id = st.id,
                    selectedCandidatePairId = m["selectedCandidatePairId"] as String?,
                    localCandidateId = m["localCandidateId"] as String?,
                    remoteCandidateId = m["remoteCandidateId"] as String?,
                    currentRoundTripTime = (m["currentRoundTripTime"] as Number?)?.toDouble(),
                    selected = m["selected"] as Boolean?,
                    nominated = m["nominated"] as Boolean?,
                    state = m["state"] as String?,
                    candidateType = m["candidateType"] as String?,
                    relayProtocol = m["relayProtocol"] as String?
                )
            }
        c.resume(RouteClassifier.classify(entries))
    }
}

/** The server route of the selected candidate pair (`direct` or `relay`), or null before one is selected. */
suspend fun PeerConnection.selectedRoute(): String? = classify().kind?.serverRoute

/**
 * Wraps an `sa-transfer/1` DataChannel as the engine's [TransferChannel]. libwebrtc calls its observer on the signaling
 * thread; every callback is re-posted to [scope] (the transfer's confined dispatcher), in order.
 */
class DataChannelAdapter(private val dc: DataChannel, private val scope: CoroutineScope, private val onOpen: () -> Unit) : TransferChannel {
    @Volatile private var listener: TransferChannel.Listener? = null

    init {
        dc.registerObserver(
            object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) {
                    scope.launch { listener?.onBufferedAmountChange() }
                }

                override fun onStateChange() {
                    when (dc.state()) {
                        DataChannel.State.OPEN -> scope.launch { onOpen() }
                        DataChannel.State.CLOSED -> scope.launch { listener?.onClose() }
                        else -> Unit
                    }
                }

                override fun onMessage(buffer: DataChannel.Buffer) {
                    if (!buffer.binary) return
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes)
                    scope.launch { listener?.onMessage(bytes) }
                }
            }
        )
    }

    override val bufferedAmount: Long get() = runCatching { dc.bufferedAmount() }.getOrDefault(0)
    override val isOpen: Boolean get() = runCatching { dc.state() == DataChannel.State.OPEN }.getOrDefault(false)

    /** libwebrtc does not expose the SCTP limit; 64 KiB frames fit every browser's limit (§2). */
    override val maxMessageSize: Int? = null

    override fun send(data: ByteArray): Boolean = isOpen && dc.send(DataChannel.Buffer(ByteBuffer.wrap(data), true))

    override fun close() {
        runCatching { dc.close() }
    }

    override fun setListener(listener: TransferChannel.Listener?) {
        this.listener = listener
    }

    fun dispose() {
        runCatching {
            dc.unregisterObserver()
            dc.dispose()
        }
    }
}
