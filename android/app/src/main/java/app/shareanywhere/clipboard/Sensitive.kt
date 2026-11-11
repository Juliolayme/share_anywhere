package app.shareanywhere.clipboard

import kotlin.math.ln

/** Why a capture looks sensitive (PRD §7.6, docs/CLIPBOARD_PROTOCOL.md §2.7). */
enum class SensitiveKind(val wire: String) {
    PRIVATE_KEY("private_key"),
    JWT("jwt"),
    OTP("otp"),
    CARD("card"),
    API_KEY("api_key"),
    TOKEN("token"),
    PASSWORD("password"),

    /** The app the text was copied from marked the clip sensitive (`ClipDescription.EXTRA_IS_SENSITIVE`, PRD §7.3). */
    FLAGGED("flagged")
}

/**
 * Best-effort "possibly sensitive" heuristics, the same rules as the Web (`web/src/features/clipboard/sensitive.ts`). They
 * run on the device before anything is encrypted or sent. Deliberately conservative: they can miss secrets or flag
 * harmless text, the UI says so, and a manual Sync can override a skip.
 */
object Sensitive {
    private val PEM_PRIVATE = Regex("-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----")
    private val JWT = Regex("(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])")
    private val API_KEY =
        Regex(
            "\\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|" +
                "xox[abposr]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{32,})\\b"
        )
    private val OTP = Regex("^\\d{4,8}$")
    private val OTP_SPLIT = Regex("^\\d{3,4}[ -]\\d{3,4}$")
    private val CARD = Regex("^(?:\\d[ -]?){12,18}\\d$")
    private val TOKEN_CHARS = Regex("^[A-Za-z0-9+/=_.~-]+$")
    private val HEX = Regex("^[0-9a-fA-F]+$")

    // JavaScript's \d and \s are ASCII-only for digits; Kotlin's \d is ASCII too. \s in JS also covers Unicode spaces.
    private fun hasSpace(s: String) = s.any { it.isWhitespace() || it == '\u00A0' || it == '\uFEFF' }

    /** Shannon entropy in bits per code point. */
    fun entropy(s: String): Double {
        val cps = s.codePoints().toArray()
        if (cps.isEmpty()) return 0.0
        val counts = HashMap<Int, Int>()
        for (c in cps) counts[c] = (counts[c] ?: 0) + 1
        var h = 0.0
        for (k in counts.values) {
            val p = k.toDouble() / cps.size
            h -= p * (ln(p) / ln(2.0))
        }
        return h
    }

    private fun luhn(digits: String): Boolean {
        var sum = 0
        var double = false
        for (i in digits.length - 1 downTo 0) {
            var d = digits[i] - '0'
            if (double) {
                d *= 2
                if (d > 9) d -= 9
            }
            sum += d
            double = !double
        }
        return sum % 10 == 0
    }

    private fun classes(s: String): Int = listOf(
        s.any { it in 'a'..'z' },
        s.any { it in 'A'..'Z' },
        s.any { it in '0'..'9' },
        s.any { !(it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9') }
    ).count { it }

    /** Why [text] looks sensitive, or null (checked in the Web's order). */
    fun kind(text: String): SensitiveKind? {
        if (PEM_PRIVATE.containsMatchIn(text)) return SensitiveKind.PRIVATE_KEY
        if (JWT.containsMatchIn(text)) return SensitiveKind.JWT
        if (API_KEY.containsMatchIn(text)) return SensitiveKind.API_KEY
        val t = text.trim()
        if (OTP.matches(t) || OTP_SPLIT.matches(t)) return SensitiveKind.OTP
        if (CARD.matches(t)) {
            val digits = t.replace(" ", "").replace("-", "")
            if (digits.length in 13..19 && luhn(digits)) return SensitiveKind.CARD
        }
        if (hasSpace(t) || t.contains("://")) return null
        val len = t.codePointCount(0, t.length)
        if (len in 24..512 && TOKEN_CHARS.matches(t)) {
            val hex = HEX.matches(t)
            if ((hex && len >= 32 && entropy(t) >= 3) || (!hex && classes(t) >= 3 && entropy(t) >= 4)) return SensitiveKind.TOKEN
        }
        if (len in 8..64 && classes(t) == 4) return SensitiveKind.PASSWORD
        return null
    }
}
