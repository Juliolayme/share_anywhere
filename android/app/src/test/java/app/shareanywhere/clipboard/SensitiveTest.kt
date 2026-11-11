package app.shareanywhere.clipboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Web's cases (`web/src/features/clipboard/sensitive.test.ts`): both clients skip the same text. */
class SensitiveTest {
    private fun kind(t: String) = Sensitive.kind(t)?.wire

    @Test
    fun oneTimeCodes() {
        for (t in listOf("4829", "482913", " 48291375 ", "482 913", "4829-1375")) assertEquals(t, "otp", kind(t))
        for (t in listOf("123", "123456789", "Code 482913 expires soon", "48 29")) assertNotEquals(t, "otp", kind(t))
    }

    @Test
    fun jsonWebTokens() {
        // Assembled at runtime so secret scanners never see a token-shaped literal in the source.
        val jwt =
            listOf(
                listOf("ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9").joinToString(""),
                listOf("ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ").joinToString(""),
                "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
            ).joinToString(".")
        assertEquals("jwt", kind(jwt))
        assertEquals("jwt", kind("Authorization: Bearer $jwt"))
    }

    @Test
    fun privateKeyBlocks() {
        for (label in listOf("RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "PRIVATE KEY", "ENCRYPTED PRIVATE KEY")) {
            assertEquals("private_key", kind("notes\n-----BEGIN $label-----\nMIIEow...\n-----END $label-----"))
        }
        fun begin(label: String) = listOf("-----", "BEGIN ", label, "-----").joinToString("")
        assertEquals("private_key", kind("${begin("PGP PRIVATE KEY BLOCK")}\nlQOYBF..."))
        assertNull(kind("${begin("CERTIFICATE")}\nMIIB...\n-----END CERTIFICATE-----"))
        assertNull(kind("${begin("PUBLIC KEY")}\nMFkw..."))
    }

    @Test
    fun apiKeys() {
        assertEquals("api_key", kind(listOf("AKIA", "IOSFODNN7EXAMPLE").joinToString("")))
        assertEquals("api_key", kind("token ${listOf("gh", "p_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789").joinToString("")} here"))
        assertEquals("api_key", kind(listOf("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc").joinToString("")))
    }

    @Test
    fun highEntropyTokens() {
        assertEquals("token", kind("Zx9qL2mN8vB4tR7wK1pS6dF3hJ5gY0cE"))
        assertEquals("token", kind("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"))
        assertNull(kind("internationalization-and-localization"))
        assertNull(kind("https://example.com/a/very/long/path?query=Zx9qL2mN8vB4tR7wK1pS6dF3"))
        assertNull(kind("Order #A-5531 ships Thursday — tracking VN829104455. Pick up at Hub D7."))
        assertEquals(0.0, Sensitive.entropy("aaaa"), 1e-9)
        assertEquals(2.0, Sensitive.entropy("abcd"), 1e-9)
    }

    @Test
    fun cardNumbers() {
        assertEquals("card", kind("4111 1111 1111 1111"))
        assertEquals("card", kind("5500-0000-0000-0004"))
        assertNull(kind("4111 1111 1111 1112"))
    }

    @Test
    fun passwordLikeWords() {
        assertEquals("password", kind("Tr0ub4dor&3"))
        assertNull(kind("hello-world"))
        assertNull(kind("Meeting at 10:30!"))
    }

    @Test
    fun ordinaryText() {
        for (t in listOf(
            "Draft reply: Thanks — I’ll send the files tonight via Share Anywhere.",
            "Tiếng Việt có dấu, không phải bí mật.",
            "https://share-anywhere.example/j/abc",
            "Call me at 0901 234 567 tomorrow",
            "e2e clipboard marker 1731300000"
        )) {
            assertNull(t, kind(t))
        }
    }
}
