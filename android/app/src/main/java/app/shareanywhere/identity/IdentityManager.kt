package app.shareanywhere.identity

import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.Authorized
import app.shareanywhere.data.api.CreateDeviceRequest
import app.shareanywhere.data.api.Device
import app.shareanywhere.data.api.DeviceApi
import app.shareanywhere.data.api.DeviceSession
import app.shareanywhere.data.api.NetworkException
import app.shareanywhere.data.api.PowSolution
import java.time.Instant
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** What the UI shows about this installation's anonymous identity (docs/UX_SCREEN_MAP.md ON-2). */
enum class IdentityStatus { Loading, SolvingChallenge, Ready, Offline, RateLimited, Failed }

data class IdentityState(
    val status: IdentityStatus = IdentityStatus.Loading,
    /** The device as the server last described it (name, platform, anonymous since). */
    val device: Device? = null,
    /** Epoch milliseconds when a rate-limited bootstrap retries by itself. */
    val retryAt: Long? = null,
    /** The API error code behind [IdentityStatus.Failed]. */
    val errorCode: String? = null,
    /** Set when refresh-secret reuse made the server revoke the device and a new identity replaced it. */
    val replaced: Boolean = false,
    /** Claims of the current access token, for display state only. */
    val claims: TokenClaims? = null
)

/**
 * Guest-first anonymous device identity (PRD §2, docs/ARCHITECTURE.md §3, docs/SECURITY_MODEL.md §4).
 *
 * - First launch: `POST /v1/devices/anonymous` with `transport: "body"`, solving the proof of work on `428`.
 * - The access token lives only in this object's memory; it is refreshed [REFRESH_MARGIN_MS] before expiry and
 *   whenever a request gets `401 device_token_expired` / `device_token_invalid` (one retry).
 * - Every refresh rotates the secret; the new secret is written to the [SecretStore] before the new token is
 *   used. Refreshes are serialized by one mutex, so this process never presents the same secret twice.
 * - `401 refresh_reused` means the server saw an old secret and revoked the device: the identity is dropped and
 *   a new one is created ([IdentityState.replaced]). Any other `401` on refresh (expired after 30 days, revoked)
 *   also creates a new identity, silently.
 * - `429` shows the wait and retries when it ends; network errors show offline with a Retry.
 */
class IdentityManager(
    private val api: DeviceApi,
    private val store: SecretStore,
    private val platform: String,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val solver: suspend (token: String, difficulty: Int) -> String = { token, difficulty ->
        withContext(Dispatchers.Default) { ProofOfWork.solve(token, difficulty) }
    }
) : Authorized {
    private val _state = MutableStateFlow(IdentityState())
    val state: StateFlow<IdentityState> = _state.asStateFlow()

    private val mutex = Mutex()
    private var token: String? = null
    private var expiresAt = 0L
    private var refreshJob: Job? = null
    private var retryJob: Job? = null
    private var bootstrapJob: Job? = null

    /** server_time − local time from the last identity response, for countdowns that follow the server clock. */
    @Volatile
    var serverOffsetMs: Long = 0
        private set

    /** Starts (or retries) the background bootstrap unless one is running or the identity is ready. */
    fun start() {
        if (bootstrapJob?.isActive == true) return
        if (_state.value.status == IdentityStatus.Ready && current() != null) return
        bootstrapJob = scope.launch { bootstrap() }
    }

    /** Clears the one-time "new identity" notice. */
    fun dismissReplaced() = _state.update { it.copy(replaced = false) }

    /** Restores the identity from the stored secret, or creates one. Errors become state, never exceptions. */
    suspend fun bootstrap() {
        cancelOwnAware(retryJob)
        _state.update { if (it.status == IdentityStatus.Ready) it else it.copy(status = IdentityStatus.Loading) }
        try {
            mutex.withLock { if (current() == null) obtainLocked() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            onError(e)
        }
    }

    /** A valid access token, refreshing or creating the identity first when needed. */
    suspend fun accessToken(): String {
        current()?.let { return it }
        try {
            return mutex.withLock { current() ?: obtainLocked().let { checkNotNull(token) } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            onError(e)
            throw e
        }
    }

    /**
     * Runs an authenticated request. When the server says the token is stale it refreshes and retries once;
     * every other error (including other 401 codes) goes back to the caller.
     */
    suspend fun <T> authorized(block: suspend (token: String) -> T): T {
        val used = accessToken()
        return try {
            block(used)
        } catch (e: ApiException) {
            if (e.status != 401 || e.code !in STALE_TOKEN) throw e
            mutex.withLock { if (token == used) token = null }
            block(accessToken())
        }
    }

    override suspend fun <T> invoke(block: suspend (token: String) -> T): T = authorized(block)

    suspend fun rename(displayName: String): Device {
        val device = authorized { api.rename(it, displayName) }
        _state.update { it.copy(device = device) }
        return device
    }

    /** `POST /v1/devices/current/reset`: the server revokes this identity and returns a new one. */
    suspend fun reset(): Device {
        val session = authorized { api.reset(it) }
        mutex.withLock { accept(session) }
        return session.device
    }

    private fun current(): String? = token?.takeIf { clock() < expiresAt - EXPIRY_SKEW_MS }

    private suspend fun obtainLocked() {
        val secret = store.read() ?: return createLocked()
        val session =
            try {
                api.refresh(secret)
            } catch (e: ApiException) {
                if (e.status != 401) throw e
                // The server no longer accepts this identity: reuse detected (revoked for safety), expired, or
                // revoked. Start over with a new anonymous identity.
                dropLocked()
                if (e.code == REFRESH_REUSED) _state.update { it.copy(replaced = true) }
                return createLocked()
            }
        accept(session)
    }

    private suspend fun createLocked() {
        var pow: PowSolution? = null
        repeat(MAX_POW_ATTEMPTS) {
            try {
                accept(api.create(CreateDeviceRequest(platform = platform, transport = "body", pow = pow)))
                return
            } catch (e: ApiException) {
                if (e.status != 428) throw e
                val challenge = api.powChallenge(e) ?: throw e
                _state.update { it.copy(status = IdentityStatus.SolvingChallenge) }
                pow = PowSolution(challenge.token, solver(challenge.token, challenge.difficulty))
            }
        }
        throw ApiException(428, "pow_required", "proof of work not accepted")
    }

    /** Takes a new session: persist the rotated secret first, then use the token. Caller holds the mutex. */
    private suspend fun accept(session: DeviceSession) {
        val secret = session.refreshSecret ?: throw ApiException(502, "refresh_secret_missing", "no refresh secret in body")
        store.write(secret)
        token = session.accessToken
        expiresAt = clock() + session.expiresIn * 1000L
        runCatching { Instant.parse(session.serverTime).toEpochMilli() }.onSuccess { serverOffsetMs = it - clock() }
        _state.update {
            it.copy(
                status = IdentityStatus.Ready,
                device = session.device,
                retryAt = null,
                errorCode = null,
                claims = TokenClaims.decode(session.accessToken)
            )
        }
        schedule(session.expiresIn * 1000L)
    }

    private suspend fun dropLocked() {
        token = null
        expiresAt = 0
        store.clear()
        cancelOwnAware(refreshJob)
        _state.update { it.copy(device = null, claims = null) }
    }

    private suspend fun schedule(lifetimeMs: Long) {
        val previous = refreshJob
        refreshJob =
            scope.launch {
                delay(maxOf(MIN_DELAY_MS, lifetimeMs - REFRESH_MARGIN_MS))
                refreshNow()
            }
        cancelOwnAware(previous)
    }

    /** Cancels [job] unless it is the coroutine running this code (a scheduled refresh rescheduling itself). */
    private suspend fun cancelOwnAware(job: Job?) {
        if (job != null && job != coroutineContext[Job]) job.cancel()
    }

    private suspend fun refreshNow() {
        try {
            mutex.withLock { obtainLocked() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The next request that needs a token tries again; the state tells the UI.
            onError(e)
        }
    }

    private fun onError(e: Exception) {
        when {
            e is NetworkException -> _state.update { it.copy(status = IdentityStatus.Offline) }
            e is ApiException && e.status == 429 -> {
                val waitMs = (e.retryAfterSeconds ?: DEFAULT_RETRY_S) * 1000L
                val at = clock() + waitMs
                _state.update { it.copy(status = IdentityStatus.RateLimited, retryAt = at) }
                retryJob?.cancel()
                retryJob =
                    scope.launch {
                        delay(waitMs)
                        bootstrap()
                    }
            }
            e is ApiException -> _state.update { it.copy(status = IdentityStatus.Failed, errorCode = e.code) }
            else -> _state.update { it.copy(status = IdentityStatus.Failed, errorCode = "internal") }
        }
    }

    companion object {
        /** Refresh this long before the access token expires (same as the Web client). */
        const val REFRESH_MARGIN_MS = 60_000L
        private const val MIN_DELAY_MS = 5_000L
        private const val EXPIRY_SKEW_MS = 5_000L
        private const val MAX_POW_ATTEMPTS = 3
        private const val DEFAULT_RETRY_S = 30
        const val REFRESH_REUSED = "refresh_reused"

        /** Only these 401 codes mean the access token itself is stale. */
        val STALE_TOKEN = setOf("device_token_invalid", "device_token_expired")
    }
}
