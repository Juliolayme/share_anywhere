package app.shareanywhere

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.shareanywhere.data.api.ApiClient
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.Authorized
import app.shareanywhere.data.api.CreateDeviceRequest
import app.shareanywhere.data.api.DeviceApi
import app.shareanywhere.data.api.PowSolution
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.di.AppEntryPoint
import app.shareanywhere.identity.ProofOfWork
import dagger.hilt.android.EntryPointAccessors
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assume.assumeTrue

/** The CI backend (android-emulator.yml passes `-Pbackend=http://10.0.2.2:8080`), or null when not set. */
object Backend {
    val url: String? get() = InstrumentationRegistry.getArguments().getString("backend")

    fun assume() = assumeTrue("needs -Pbackend", url != null)

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
    private val http = OkHttpClient()

    fun entry(): AppEntryPoint =
        EntryPointAccessors.fromApplication(ApplicationProvider.getApplicationContext<Application>(), AppEntryPoint::class.java)

    /** A string from the app's catalog (the device language: English on the CI emulator). */
    fun entryString(id: Int): String = ApplicationProvider.getApplicationContext<Application>().getString(id)

    /** Skips Welcome so a test starts on Transfer home. */
    fun markWelcomed() = runBlocking { entry().settingsRepository().markWelcomed() }

    /** Moves the test backend's clock (testhooks build, SA_ENV=test) and runs its expiry jobs. */
    fun advanceClock(seconds: Int) {
        val req =
            Request
                .Builder()
                .url("${checkNotNull(url)}/v1/_test/clock")
                .post("""{"advance_seconds":$seconds}""".toRequestBody("application/json".toMediaType()))
                .build()
        http.newCall(req).execute().use { check(it.isSuccessful) { "clock hook: ${it.code}" } }
    }

    /** Another guest device talking to the same backend (the peer in sender and receiver tests). */
    class Peer private constructor(val api: SessionsApi, val displayName: String) {
        companion object {
            fun create(platform: String = "Chrome on Linux"): Peer = runBlocking {
                val client = ApiClient(checkNotNull(url), http, json, requireHttps = false, userAgent = "ShareAnywhere-AndroidTest")
                val devices = DeviceApi(client)
                val request = CreateDeviceRequest(platform = platform, transport = "body")
                // The first attempt is answered with a proof-of-work challenge (428), like the app's own bootstrap.
                val session =
                    try {
                        devices.create(request)
                    } catch (e: ApiException) {
                        val c = devices.powChallenge(e) ?: throw e
                        devices.create(request.copy(pow = PowSolution(c.token, ProofOfWork.solve(c.token, c.difficulty))))
                    }
                val auth =
                    object : Authorized {
                        override suspend fun <T> invoke(block: suspend (token: String) -> T): T = block(session.accessToken)
                    }
                Peer(SessionsApi(client, auth), session.device.displayName)
            }
        }
    }
}
