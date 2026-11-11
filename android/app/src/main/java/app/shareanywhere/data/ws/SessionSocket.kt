package app.shareanywhere.data.ws

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.math.pow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.onSubscription
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
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** One server message (shared/protocol/websocket-events.json), or a synthetic SOCKET_OPEN / SOCKET_CLOSED. */
data class SocketEvent(val type: String, val body: JsonObject) {
    val sessionId: String? get() = body["session_id"]?.jsonPrimitive?.contentOrNull

    companion object {
        const val OPEN = "SOCKET_OPEN"
        const val CLOSED = "SOCKET_CLOSED"
    }
}

/**
 * The app's one WebSocket (docs/API.md §4), shared by every screen that needs live session events: it fetches a
 * one-time ticket, connects without an `Origin` header (native clients send none; the ticket authenticates),
 * dispatches events, and reconnects with jittered exponential backoff while anything is subscribed.
 * SOCKET_OPEN follows the server's WELCOME, so subscribers reload state after every (re)connect.
 * Nothing about tickets or payloads is logged.
 */
class SessionSocket(
    baseUrl: String,
    http: OkHttpClient,
    private val json: Json,
    private val scope: CoroutineScope,
    private val ticket: suspend () -> String,
    private val random: () -> Double = Math::random,
    private val pause: suspend (Long) -> Unit = { delay(it) }
) {
    private val base = baseUrl.trimEnd('/').toHttpUrl()
    private val http = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(PING_S, TimeUnit.SECONDS).build()
    private val events = MutableSharedFlow<SocketEvent>(extraBufferCapacity = BUFFER)
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val lock = Any()
    private var holders = 0
    private var job: Job? = null

    @Volatile private var socket: WebSocket? = null

    /** Live events; the socket stays connected while at least one collector is active. */
    fun subscribe(): Flow<SocketEvent> = events.onSubscription { acquire() }.onCompletion { release() }

    /** Sends a client message (signaling). False when the socket is not connected. */
    fun send(message: JsonObject): Boolean {
        val ws = socket ?: return false
        if (!_connected.value) return false
        return ws.send(json.encodeToString(JsonObject.serializer(), message))
    }

    private fun acquire() = synchronized(lock) {
        holders++
        if (job?.isActive != true) job = scope.launch { loop() }
    }

    private fun release() = synchronized(lock) {
        holders = (holders - 1).coerceAtLeast(0)
        if (holders == 0) {
            job?.cancel()
            job = null
        }
    }

    private suspend fun loop() {
        var attempt = 0
        while (currentCoroutineContext().isActive) {
            val welcomed =
                try {
                    connectOnce()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    false // ticket request failed (offline, 401 after refresh, 429): back off and retry
                }
            if (welcomed) attempt = 0
            pause(backoffMs(attempt++))
        }
    }

    /** Jittered exponential backoff: 1 s, 2 s, 4 s … capped at 30 s, ±25 %. */
    internal fun backoffMs(attempt: Int): Long {
        val raw = min(MAX_BACKOFF_MS.toDouble(), 1000.0 * 2.0.pow(attempt.coerceAtMost(15)))
        return (raw * (0.75 + random() * 0.5)).toLong()
    }

    /** One connection; returns whether the server welcomed it. Suspends until the socket closes. */
    private suspend fun connectOnce(): Boolean {
        val t = ticket()
        val url = base.newBuilder().encodedPath("/v1/ws").addQueryParameter("ticket", t).build()
        val closed = CompletableDeferred<Unit>()
        val welcomed = AtomicBoolean(false)
        val listener =
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                    val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return
                    if (type == "WELCOME" && welcomed.compareAndSet(false, true)) {
                        _connected.value = true
                        events.tryEmit(SocketEvent(SocketEvent.OPEN, buildJsonObject { put("type", SocketEvent.OPEN) }))
                    }
                    events.tryEmit(SocketEvent(type, obj))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(NORMAL, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    closed.complete(Unit)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    closed.complete(Unit)
                }
            }
        val ws = http.newWebSocket(Request.Builder().url(url).build(), listener)
        socket = ws
        try {
            closed.await()
        } finally {
            withContext(NonCancellable) {
                if (socket === ws) socket = null
                ws.cancel()
                if (welcomed.get()) {
                    _connected.value = false
                    events.tryEmit(SocketEvent(SocketEvent.CLOSED, buildJsonObject { put("type", SocketEvent.CLOSED) }))
                }
            }
        }
        return welcomed.get()
    }

    private companion object {
        const val NORMAL = 1000
        const val PING_S = 25L
        const val MAX_BACKOFF_MS = 30_000L
        const val BUFFER = 256
    }
}
