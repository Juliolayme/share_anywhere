package app.shareanywhere.transfer.rtc

import android.content.Context
import app.shareanywhere.data.api.TransfersApi
import app.shareanywhere.transfer.engine.TransferChannel
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
     * ICE servers for a session, as the Web's rtcConfig: the TURN credentials plus a `stun:` URI on the same host and
     * port. Without credentials, direct candidates may still connect.
     */
    suspend fun iceServers(api: TransfersApi, sessionId: String): List<PeerConnection.IceServer> = try {
        val c = api.turn(sessionId)
        val stun = c.uris.filter { it.startsWith("turn:") }.map { it.replaceFirst("turn:", "stun:").substringBefore('?') }.distinct()
        buildList {
            if (stun.isNotEmpty()) add(PeerConnection.IceServer.builder(stun).createIceServer())
            if (c.uris.isNotEmpty()) {
                add(
                    PeerConnection.IceServer.builder(c.uris).setUsername(c.username).setPassword(c.credential).createIceServer()
                )
            }
        }
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Exception) {
        emptyList()
    }

    fun config(servers: List<PeerConnection.IceServer>) = PeerConnection.RTCConfiguration(servers).apply {
        sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
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

/** The route of the selected candidate pair: relay when either end is a TURN relay candidate (docs/TRANSFER_PROTOCOL.md §7). */
suspend fun PeerConnection.selectedRoute(): String? = suspendCancellableCoroutine { c ->
    getStats { report ->
        val stats = report.statsMap
        val pairId = stats.values.firstOrNull { it.type == "transport" }?.members?.get("selectedCandidatePairId") as String?
        val pair =
            stats.values.firstOrNull {
                it.type == "candidate-pair" &&
                    (it.id == pairId || (pairId == null && it.members["nominated"] == true && it.members["state"] == "succeeded"))
            }
        val route =
            pair?.let { p ->
                fun type(id: Any?) = stats[id as String?]?.members?.get("candidateType")
                if (type(p.members["localCandidateId"]) == "relay" || type(p.members["remoteCandidateId"]) == "relay") "relay" else "direct"
            }
        c.resume(route)
    }
}

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
