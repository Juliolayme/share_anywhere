package app.shareanywhere.identity

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenClaimsTest {
    private fun jwt(payload: String) = listOf("""{"alg":"EdDSA","kid":"k1"}""", payload, "sig")
        .joinToString(".") { Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray()) }

    @Test
    fun decodesGuestClaims() {
        val c = TokenClaims.decode(jwt("""{"sub":"d1","typ":"device","gen":2,"exp":1900000000}"""))!!
        assertEquals("d1", c.sub)
        assertNull(c.acct)
        assertFalse(c.dl)
        assertEquals(1_900_000_000L, c.exp)
    }

    @Test
    fun decodesAccountClaimsAndIgnoresEmptyAccount() {
        assertEquals("u1", TokenClaims.decode(jwt("""{"sub":"d1","acct":"u1","dl":true}"""))!!.acct)
        assertTrue(TokenClaims.decode(jwt("""{"sub":"d1","acct":"u1","dl":true}"""))!!.dl)
        assertNull(TokenClaims.decode(jwt("""{"sub":"d1","acct":""}"""))!!.acct)
    }

    @Test
    fun rejectsAnythingThatIsNotAJwt() {
        assertNull(TokenClaims.decode("not-a-token"))
        assertNull(TokenClaims.decode("a..c"))
        assertNull(TokenClaims.decode("a.%%%.c"))
        assertNull(TokenClaims.decode("a.${Base64.getUrlEncoder().encodeToString("[1]".toByteArray())}.c"))
    }
}
