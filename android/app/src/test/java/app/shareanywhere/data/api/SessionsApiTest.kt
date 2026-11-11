package app.shareanywhere.data.api

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionsApiTest {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private object FixedToken : Authorized {
        override suspend fun <T> invoke(block: suspend (token: String) -> T): T = block("tok")
    }

    private val session =
        """{"id":"11111111-1111-1111-1111-111111111111","role":"sender","status":"WAITING","require_approval":false,
           "code":"482913","join_url":"http://x/j/t","files":[{"id":"f1","name":"a.txt","size":3,"mime":"text/plain"}],
           "total_bytes":3,"file_count":1,"protected_mode":false,"expires_at":"2026-01-01T00:00:00Z","server_time":"2026-01-01T00:00:00Z"}"""
    private val participant =
        """{"id":"p 1","role":"receiver","status":"JOINED","display_name":"Maple River","platform":"Android","signed_in":false}"""
    private val preview =
        """{"session_id":"s1","sender":{"participant_id":"p0","display_name":"Minh","platform":"Chrome","signed_in":true},
           "files":[],"total_bytes":0,"file_count":0,"require_approval":false,"protected_mode":false,
           "join_window_ends_at":"2026-01-01T00:10:00Z","join_ticket":"jt","join_ticket_expires_at":"2026-01-01T00:05:00Z",
           "via":"code","server_time":"2026-01-01T00:00:00Z"}"""

    @Test
    fun everyCallUsesTheDeviceTokenAndTheDocumentedRoute() = runBlocking {
        MockWebServer().use { server ->
            repeat(3) { server.enqueue(MockResponse().setBody(session)) }
            server.enqueue(MockResponse().setBody(preview))
            server.enqueue(MockResponse().setBody(preview))
            server.enqueue(
                MockResponse().setBody("""{"session_id":"s1","participant":$participant,"server_time":"2026-01-01T00:00:00Z"}""")
            )
            repeat(2) { server.enqueue(MockResponse().setBody(participant)) }
            server.enqueue(MockResponse().setBody("""{"status":"closed"}"""))
            server.enqueue(MockResponse().setBody("""{"ticket":"wt","expires_in":30}"""))
            server.start()
            val api = SessionsApi(ApiClient(server.url("/").toString(), OkHttpClient(), json, false, "t"), FixedToken)

            val created = api.create(listOf(FileInput("a.txt", 3, "text/plain")), requireApproval = true)
            assertEquals("482913", created.code)
            api.update("s 1", UpdateSessionRequest(acceptingReceivers = false))
            api.renew("s1")
            api.resolveCode("482913")
            api.resolveLink("tok123")
            api.join("s1", "jt")
            api.decide("p 1", Decision.Block)
            api.remove("p1")
            api.close("s1")
            assertEquals("wt", api.wsTicket().ticket)

            val expected =
                listOf(
                    "POST /v1/sessions",
                    "PATCH /v1/sessions/s%201",
                    "POST /v1/sessions/s1/renew",
                    "POST /v1/sessions/resolve-code",
                    "POST /v1/sessions/resolve-link",
                    "POST /v1/sessions/s1/join",
                    "POST /v1/participants/p%201/block",
                    "DELETE /v1/participants/p1",
                    "POST /v1/sessions/s1/close",
                    "POST /v1/ws/ticket"
                )
            val bodies = mutableListOf<String>()
            for (e in expected) {
                val r = server.takeRequest()
                assertEquals(e, "${r.method} ${r.path}")
                assertEquals("Bearer tok", r.getHeader("Authorization"))
                bodies += r.body.readUtf8()
            }
            val create = json.parseToJsonElement(bodies[0]).jsonObject
            assertEquals("true", create["require_approval"]!!.jsonPrimitive.content)
            assertEquals("""{"accepting_receivers":false}""", bodies[1])
            assertEquals("""{"code":"482913"}""", bodies[3])
            assertEquals("""{"token":"tok123"}""", bodies[4])
            assertEquals("""{"ticket":"jt"}""", bodies[5])
            assertTrue(bodies[6].isEmpty())
        }
    }
}
