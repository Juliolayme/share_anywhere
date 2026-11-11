package app.shareanywhere.sharing

import app.shareanywhere.R
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.NetworkException
import java.io.IOException
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SharingTest {
    private val origin = "https://share.example.com"

    // A 32-character base64url token built at runtime, so secret scanners do not mistake a fixture for a key.
    private val token = ('A'..'Z').take(16).joinToString("") + "_-" + (0..9).joinToString("") + "abcd"

    @Test
    fun countdownFollowsTheServerClock() {
        val now = 1_700_000_000_000L
        val serverAhead = Instant.ofEpochMilli(now + 5_000).toString()
        val offset = serverOffset(serverAhead, now)
        assertEquals(5_000L, offset)
        val ends = Instant.ofEpochMilli(now + 5_000 + 600_000).toString()
        assertEquals(600L, secondsUntil(ends, offset, now))
        assertEquals(1L, secondsUntil(Instant.ofEpochMilli(now + 5_000 + 1).toString(), offset, now))
        assertEquals(0L, secondsUntil(Instant.ofEpochMilli(now).toString(), offset, now))
        assertEquals(0L, secondsUntil("not a date", offset, now))
        assertEquals(0L, serverOffset("garbage", now))
    }

    @Test
    fun mmssFormatsCountdowns() {
        assertEquals("10:00", mmss(600))
        assertEquals("0:59", mmss(59))
        assertEquals("0:00", mmss(-3))
    }

    @Test
    fun codesKeepSixDigitsOnly() {
        assertEquals("482913", normalizeCode("482 913"))
        assertEquals("482913", normalizeCode("48-29-13-77"))
        assertEquals("", normalizeCode("abc"))
        assertEquals("non-ASCII digits are not code digits", "", normalizeCode("١٢٣٤٥٦"))
    }

    @Test
    fun onlyThisAppsShareLinksAreAccepted() {
        assertEquals(token, linkTokenFrom("$origin/j/$token", origin))
        assertEquals(token, linkTokenFrom("  $origin/j/$token  ", origin))
        assertNull(linkTokenFrom("https://evil.example.com/j/$token", origin))
        assertNull(linkTokenFrom("http://share.example.com/j/$token", origin))
        assertNull(linkTokenFrom("https://share.example.com:8443/j/$token", origin))
        assertNull(linkTokenFrom("$origin/x/$token", origin))
        assertNull(linkTokenFrom("$origin/j/$token/extra", origin))
        assertNull(linkTokenFrom("$origin/j/$token?x=1", origin))
        assertNull(linkTokenFrom("$origin/j/short", origin))
        assertNull(linkTokenFrom("$origin/j/$token!!", origin))
        assertNull(linkTokenFrom("482913", origin))
        assertEquals(token, linkTokenFrom("http://localhost:8080/j/$token", "http://localhost:8080"))
    }

    @Test
    fun lookupErrorsMapToTheWebMessages() {
        fun api(code: String, retry: Int? = null) = ApiException(400, code, "", retry)
        assertEquals(R.string.common_nf_rx, joinErrorMessage(api("code_not_found")).id)
        assertEquals(R.string.common_cx_rx, joinErrorMessage(api("join_window_expired")).id)
        assertEquals(R.string.common_cx_rx, joinErrorMessage(api("link_not_found")).id)
        assertEquals(R.string.common_cx_rx, joinErrorMessage(api("join_ticket_invalid")).id)
        assertEquals(R.string.product_session_full_rx, joinErrorMessage(api("session_full")).id)
        assertEquals(R.string.product_not_accepting_rx, joinErrorMessage(api("session_not_accepting")).id)
        assertEquals(R.string.product_blocked_rx, joinErrorMessage(api("blocked")).id)
        assertEquals(R.string.product_own_session, joinErrorMessage(api("own_session")).id)
        val locked = joinErrorMessage(api("locked_out", 900))
        assertEquals(R.string.product_rate_limited, locked.id)
        assertEquals("15:00", locked.args["time"])
        assertEquals("1:00", joinErrorMessage(api("rate_limited")).args["time"])
        assertEquals(R.string.product_identity_offline, joinErrorMessage(NetworkException(IOException("x"))).id)
        assertEquals(R.string.product_error_generic, joinErrorMessage(IllegalStateException()).id)
    }
}
