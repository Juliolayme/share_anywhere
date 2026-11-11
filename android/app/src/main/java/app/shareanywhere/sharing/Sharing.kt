package app.shareanywhere.sharing

import androidx.annotation.StringRes
import app.shareanywhere.R
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.NetworkException
import java.time.Instant
import java.time.format.DateTimeParseException
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Milliseconds to add to the local clock to follow the server's, from a response's `server_time`. */
fun serverOffset(serverTime: String, now: Long = System.currentTimeMillis()): Long = parseInstant(serverTime)?.let { it - now } ?: 0L

/** Whole seconds left until an ISO timestamp on the server clock, rounded up and never negative. */
fun secondsUntil(iso: String, offsetMs: Long, now: Long = System.currentTimeMillis()): Long {
    val t = parseInstant(iso) ?: return 0
    val ms = t - (now + offsetMs)
    return if (ms <= 0) 0 else (ms + 999) / 1000
}

/** "m:ss" for countdowns (10:00, 0:59). */
fun mmss(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

private fun parseInstant(iso: String): Long? = try {
    Instant.parse(iso).toEpochMilli()
} catch (_: DateTimeParseException) {
    null
}

/** Keeps the digits of what was typed or pasted, at most six (RX-2). */
fun normalizeCode(raw: String): String = raw.filter { it in '0'..'9' }.take(CODE_LENGTH)

const val CODE_LENGTH = 6

private val TOKEN = Regex("[A-Za-z0-9_-]{22,128}")

/**
 * The capability token from a share link or QR payload: `<public origin>/j/<base64url token>` (docs/API.md §2.2).
 * Links to any other origin are refused, as on the Web, so a QR code cannot point the app somewhere else.
 */
fun linkTokenFrom(raw: String, publicOrigin: String): String? {
    val url = raw.trim().toHttpUrlOrNull() ?: return null
    val origin = publicOrigin.toHttpUrlOrNull() ?: return null
    if (!sameOrigin(url, origin)) return null
    val segs = url.pathSegments
    if (segs.size != 2 || segs[0] != "j" || url.querySize != 0 || url.fragment != null) return null
    return segs[1].takeIf { TOKEN.matches(it) }
}

private fun sameOrigin(a: HttpUrl, b: HttpUrl) = a.scheme == b.scheme && a.host == b.host && a.port == b.port

/** A user-facing message for a lookup or join failure (docs/API.md §3; UX_SCREEN_MAP RX-2, RX-4, RX-7). */
data class UiMessage(@StringRes val id: Int, val args: Map<String, Any> = emptyMap())

fun joinErrorMessage(e: Throwable): UiMessage {
    if (e is NetworkException) return UiMessage(R.string.product_identity_offline)
    if (e !is ApiException) return UiMessage(R.string.product_error_generic)
    return when (e.code) {
        "code_not_found" -> UiMessage(R.string.common_nf_rx)
        "join_window_expired", "link_not_found", "join_ticket_invalid" -> UiMessage(R.string.common_cx_rx)
        "session_full" -> UiMessage(R.string.product_session_full_rx)
        "session_not_accepting" -> UiMessage(R.string.product_not_accepting_rx)
        "blocked" -> UiMessage(R.string.product_blocked_rx)
        "session_expired" -> UiMessage(R.string.product_session_ended_rx)
        "own_session" -> UiMessage(R.string.product_own_session)
        "locked_out", "rate_limited" -> UiMessage(
            R.string.product_rate_limited,
            mapOf("time" to mmss((e.retryAfterSeconds ?: 60).toLong()))
        )
        else -> UiMessage(R.string.product_error_generic)
    }
}

/** Session statuses in which the session is live (docs/ARCHITECTURE.md §4.5). */
val LIVE_STATUSES = setOf("WAITING", "ACTIVE")
