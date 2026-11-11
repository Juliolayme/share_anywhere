package app.shareanywhere.identity

import app.shareanywhere.data.api.ApiClient
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.DeviceApi
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Identity and refresh state machine against a scripted backend (docs/SECURITY_MODEL.md §4). */
class IdentityManagerTest {
    private class MemoryStore(var value: String? = null) : SecretStore {
        val writes = CopyOnWriteArrayList<String>()

        override suspend fun read() = value

        override suspend fun write(secret: String) {
            value = secret
            writes += secret
        }

        override suspend fun clear() {
            value = null
        }
    }

    private val server = MockWebServer()
    private val json = Json { ignoreUnknownKeys = true }
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val generation = AtomicInteger(0)
    private var now = 1_000_000L
    private lateinit var scope: CoroutineScope

    /** Per-path scripted answers; the default answer issues a new identity or a rotated secret. */
    private val script = mutableMapOf<String, ArrayDeque<MockResponse>>()

    private fun token(gen: Int) = listOf("""{"alg":"EdDSA"}""", """{"sub":"dev-1","typ":"device","gen":$gen}""", "s")
        .joinToString(".") { Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray()) }

    private fun session(device: String = "dev-1", status: Int = 200): MockResponse {
        val gen = generation.incrementAndGet()
        return MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(
            """{"device":{"id":"$device","kind":"anonymous","display_name":"Android · Pixel · Calm Otter","platform":"Android · Pixel",
               "created_at":"2026-11-01T10:00:00Z","last_seen_at":"2026-11-11T10:00:00Z"},
               "access_token":"${token(gen)}","expires_in":900,"refresh_secret":"secret-$gen","server_time":"2026-11-11T10:00:00Z"}"""
        )
    }

    private fun error(status: Int, code: String, extra: String = "") =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json")
            .setBody("""{"error":"$code","message":"m"$extra}""")

    @Before
    fun setUp() {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val path = request.path!!.substringBefore('?')
                    script[path]?.removeFirstOrNull()?.let { return it }
                    return when (path) {
                        "/v1/devices/anonymous" -> session(status = 201)
                        "/v1/devices/token" -> session()
                        "/v1/devices/current" -> MockResponse().setHeader("Content-Type", "application/json").setBody(
                            """{"id":"dev-1","kind":"anonymous","display_name":"Renamed","platform":"Android · Pixel",
                               "created_at":"2026-11-01T10:00:00Z","last_seen_at":"2026-11-11T10:00:00Z"}"""
                        )
                        "/v1/devices/current/reset" -> session(device = "dev-2", status = 201)
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
        server.start()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.shutdown()
    }

    private fun manager(store: SecretStore): IdentityManager {
        val client = ApiClient(server.url("/").toString(), OkHttpClient(), json, requireHttps = false, userAgent = "test")
        return IdentityManager(DeviceApi(client), store, "Android · Pixel", scope, clock = { now })
    }

    private fun queue(path: String, vararg responses: MockResponse) {
        script.getOrPut(path) { ArrayDeque() }.addAll(responses)
    }

    private fun paths() = requests.map { it.path!! }

    private fun body(r: RecordedRequest) = json.parseToJsonElement(r.body.readUtf8()).jsonObject

    @Test
    fun firstLaunchCreatesAnAnonymousDeviceWithBodyTransportAndStoresTheSecret() = runBlocking {
        val store = MemoryStore()
        val m = manager(store)
        m.bootstrap()
        assertEquals(IdentityStatus.Ready, m.state.value.status)
        assertEquals("dev-1", m.state.value.device?.id)
        assertEquals(listOf("/v1/devices/anonymous"), paths())
        val b = body(requests.single())
        assertEquals("body", b["transport"]!!.jsonPrimitive.content)
        assertEquals("Android · Pixel", b["platform"]!!.jsonPrimitive.content)
        assertNull(b["pow"])
        assertEquals("secret-1", store.value)
        assertEquals(token(1), m.accessToken())
    }

    @Test
    fun solvesTheProofOfWorkWhenTheServerAsksForIt() = runBlocking {
        queue(
            "/v1/devices/anonymous",
            error(428, "pow_required", ""","challenge":{"token":"tok.sig","difficulty":6,"expires_in":300}""")
        )
        val m = manager(MemoryStore())
        m.bootstrap()
        assertEquals(IdentityStatus.Ready, m.state.value.status)
        assertEquals(2, requests.size)
        val pow = body(requests[1])["pow"]!!.jsonObject
        assertEquals("tok.sig", pow["token"]!!.jsonPrimitive.content)
        assertTrue(ProofOfWork.verify("tok.sig", pow["solution"]!!.jsonPrimitive.content, 6))
    }

    @Test
    fun storedSecretIsRotatedOnRefreshAndTheNewOneIsPersistedFirst() = runBlocking {
        val store = MemoryStore("old-secret")
        val m = manager(store)
        m.bootstrap()
        assertEquals(listOf("/v1/devices/token"), paths())
        assertEquals("old-secret", body(requests.single())["refresh_secret"]!!.jsonPrimitive.content)
        assertEquals("secret-1", store.value)
        assertEquals(IdentityStatus.Ready, m.state.value.status)
    }

    @Test
    fun refreshesSilentlyWhenTheAccessTokenIsAboutToExpire() = runBlocking {
        val store = MemoryStore()
        val m = manager(store)
        m.bootstrap()
        assertEquals(token(1), m.accessToken())
        now += 900_000 - 4_000 // within the 5 s skew of the 15-minute expiry
        assertEquals(token(2), m.accessToken())
        assertEquals(listOf("/v1/devices/anonymous", "/v1/devices/token"), paths())
        assertEquals("secret-1", body(requests[1])["refresh_secret"]!!.jsonPrimitive.content)
        assertEquals("secret-2", store.value)
    }

    @Test
    fun concurrentCallersShareOneRefreshSoNoSecretIsPresentedTwice() = runBlocking {
        val m = manager(MemoryStore())
        m.bootstrap()
        now += 2 * 900_000
        val tokens = (1..8).map { async(Dispatchers.Default) { m.accessToken() } }.awaitAll()
        assertEquals(setOf(token(2)), tokens.toSet())
        assertEquals(1, paths().count { it == "/v1/devices/token" })
    }

    @Test
    fun staleTokenAnswerRefreshesAndRetriesOnce() = runBlocking {
        queue("/v1/devices/current", error(401, "device_token_expired"))
        val m = manager(MemoryStore())
        m.bootstrap()
        val device = m.rename("Renamed")
        assertEquals("Renamed", device.displayName)
        assertEquals(listOf("/v1/devices/anonymous", "/v1/devices/current", "/v1/devices/token", "/v1/devices/current"), paths())
        assertEquals("Bearer ${token(1)}", requests[1].getHeader("Authorization"))
        assertEquals("Bearer ${token(2)}", requests[3].getHeader("Authorization"))
    }

    @Test
    fun otherErrorsAreNotRetried() = runBlocking {
        queue("/v1/devices/current", error(400, "invalid_request"), error(401, "invalid_credentials"))
        val m = manager(MemoryStore())
        m.bootstrap()
        for (expected in listOf("invalid_request", "invalid_credentials")) {
            try {
                m.rename("x")
                fail("expected $expected")
            } catch (e: ApiException) {
                assertEquals(expected, e.code)
            }
        }
        assertEquals(0, paths().count { it == "/v1/devices/token" })
    }

    @Test
    fun refreshReuseResetsTheIdentity() = runBlocking {
        queue("/v1/devices/token", error(401, "refresh_reused"))
        val store = MemoryStore("stolen-or-replayed")
        val m = manager(store)
        m.bootstrap()
        assertEquals(listOf("/v1/devices/token", "/v1/devices/anonymous"), paths())
        assertTrue(m.state.value.replaced)
        assertEquals(IdentityStatus.Ready, m.state.value.status)
        assertEquals("secret-1", store.value)
        m.dismissReplaced()
        assertFalse(m.state.value.replaced)
    }

    @Test
    fun anExpiredIdentityIsReplacedSilently() = runBlocking {
        queue("/v1/devices/token", error(401, "refresh_invalid"))
        val m = manager(MemoryStore("expired"))
        m.bootstrap()
        assertEquals(listOf("/v1/devices/token", "/v1/devices/anonymous"), paths())
        assertFalse(m.state.value.replaced)
        assertEquals(IdentityStatus.Ready, m.state.value.status)
    }

    @Test
    fun rateLimitShowsTheWaitFromTheServer() = runBlocking {
        queue("/v1/devices/anonymous", error(429, "rate_limited", ""","retry_after_s":42"""))
        val m = manager(MemoryStore())
        m.bootstrap()
        assertEquals(IdentityStatus.RateLimited, m.state.value.status)
        assertEquals(now + 42_000, m.state.value.retryAt)
    }

    @Test
    fun unreachableBackendIsOffline() = runBlocking {
        val store = MemoryStore()
        val port = server.port
        server.shutdown()
        val client = ApiClient("http://127.0.0.1:$port/", OkHttpClient(), json, requireHttps = false, userAgent = "test")
        val m = IdentityManager(DeviceApi(client), store, "Android · Pixel", scope, clock = { now })
        m.bootstrap()
        assertEquals(IdentityStatus.Offline, m.state.value.status)
        assertNull(store.value)
    }

    @Test
    fun resetReplacesTheIdentityAndStoresItsSecret() = runBlocking {
        val store = MemoryStore()
        val m = manager(store)
        m.bootstrap()
        val device = m.reset()
        assertEquals("dev-2", device.id)
        assertEquals("dev-2", m.state.value.device?.id)
        assertEquals("secret-2", store.value)
        assertNotNull(requests.last().getHeader("Authorization"))
    }

    @Test
    fun secretsNeverTravelInHeadersOrQueryStrings() = runBlocking {
        val m = manager(MemoryStore("s3cret"))
        m.bootstrap()
        for (r in requests) {
            assertFalse(r.path!!.contains("s3cret"))
            assertFalse(r.headers.toString().contains("s3cret"))
        }
    }
}
