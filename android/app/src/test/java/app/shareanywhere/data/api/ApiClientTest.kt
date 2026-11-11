package app.shareanywhere.data.api

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class ApiClientTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test(expected = IllegalArgumentException::class)
    fun releaseBuildsRefuseCleartext() {
        ApiClient("http://10.0.2.2:8080", OkHttpClient(), json, requireHttps = true, userAgent = "t")
    }

    @Test
    fun errorBodiesAndRetryAfterBecomeApiExceptions() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse().setResponseCode(
                    429
                ).setHeader("Retry-After", "17").setBody("""{"error":"rate_limited","message":"slow"}""")
            )
            server.enqueue(MockResponse().setResponseCode(503).setBody("<html>"))
            server.start()
            val client = ApiClient(server.url("/").toString(), OkHttpClient(), json, requireHttps = false, userAgent = "t")
            try {
                client.send(ApiOperations.getDeviceChallenge)
                fail()
            } catch (e: ApiException) {
                assertEquals(429, e.status)
                assertEquals("rate_limited", e.code)
                assertEquals(17, e.retryAfterSeconds)
            }
            try {
                client.send(ApiOperations.getDeviceChallenge)
                fail()
            } catch (e: ApiException) {
                assertEquals("http_503", e.code)
                assertNull(e.retryAfterSeconds)
            }
            assertEquals("GET", server.takeRequest().method)
        }
    }

    @Test
    fun pathTemplatesAreFilledInOrder() {
        assertEquals("/v1/participants/p1/approve", ApiOperations.approveParticipant.path("p1"))
    }
}
