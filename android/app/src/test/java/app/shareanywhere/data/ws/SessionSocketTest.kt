package app.shareanywhere.data.ws

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionSocketTest {
    private val json = Json { ignoreUnknownKeys = true }

    /** A server socket that sends WELCOME and one event, then (optionally) closes. */
    private fun upgrade(closeAfter: Boolean, received: MutableList<String> = mutableListOf()) = MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"WELCOME","device_id":"d","server_time":"2026-01-01T00:00:00Z"}""")
                webSocket.send("""{"type":"PARTICIPANT_JOINED","session_id":"s1","participant":{}}""")
                webSocket.send("not json")
                if (closeAfter) webSocket.close(1000, null)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                synchronized(received) { received += text }
            }
        }
    )

    @Test
    fun connectsWithAOneTimeTicketAndNoOriginAndReconnects() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(upgrade(closeAfter = true))
            server.enqueue(upgrade(closeAfter = false))
            server.start()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val tickets = AtomicInteger()
            val socket =
                SessionSocket(server.url("/").toString(), OkHttpClient(), json, scope, ticket = {
                    "t${tickets.incrementAndGet()}"
                }, pause = { })
            val events = withTimeout(10_000) { socket.subscribe().take(7).toList() }
            assertEquals(
                listOf("SOCKET_OPEN", "WELCOME", "PARTICIPANT_JOINED", "SOCKET_CLOSED", "SOCKET_OPEN", "WELCOME", "PARTICIPANT_JOINED"),
                events.map { it.type }
            )
            assertEquals("s1", events[2].sessionId)
            val first = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("/v1/ws?ticket=t1", first.path)
            assertNull("native clients send no Origin", first.getHeader("Origin"))
            assertEquals("/v1/ws?ticket=t2", server.takeRequest(5, TimeUnit.SECONDS)!!.path)
            scope.cancel()
        }
    }

    @Test
    fun sendWorksOnlyWhileConnected() = runBlocking {
        MockWebServer().use { server ->
            val received = mutableListOf<String>()
            server.enqueue(upgrade(closeAfter = false, received))
            server.start()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val socket = SessionSocket(server.url("/").toString(), OkHttpClient(), json, scope, ticket = { "t" }, pause = { })
            assertFalse(socket.send(buildJsonObject { put("type", "OFFER") }))
            val collector = scope.launch { socket.subscribe().collect { } }
            withTimeout(10_000) { socket.connected.first { it } }
            assertTrue(socket.send(buildJsonObject { put("type", "OFFER") }))
            withTimeout(10_000) {
                while (synchronized(received) { received.isEmpty() }) kotlinx.coroutines.delay(20)
            }
            assertEquals("""{"type":"OFFER"}""", synchronized(received) { received.first() })
            collector.cancel()
            withTimeout(10_000) { socket.connected.first { !it } }
            scope.cancel()
        }
    }

    @Test
    fun backoffGrowsAndIsCapped() {
        val socket =
            SessionSocket("http://localhost", OkHttpClient(), json, CoroutineScope(Dispatchers.IO), ticket = { "t" }, random = { 0.5 })
        assertEquals(1000L, socket.backoffMs(0))
        assertEquals(2000L, socket.backoffMs(1))
        assertEquals(16000L, socket.backoffMs(4))
        assertEquals(30000L, socket.backoffMs(5))
        assertEquals(30000L, socket.backoffMs(60))
        val low =
            SessionSocket("http://localhost", OkHttpClient(), json, CoroutineScope(Dispatchers.IO), ticket = { "t" }, random = { 0.0 })
        assertEquals(750L, low.backoffMs(0))
    }
}
