package app.shareanywhere.identity

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Claims of a device access token read for display state only (docs/ADR/0008-device-token-format.md): the
 * server verifies the EdDSA signature and decides access on every request, so nothing here is trusted.
 */
data class TokenClaims(
    /** Device ID. */
    val sub: String?,
    /** Account ID while this device has an account session (milestone 6.4). */
    val acct: String?,
    /** True when the device is added to that account. */
    val dl: Boolean,
    /** Expiry in epoch seconds. */
    val exp: Long?
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** Decodes the payload of a JWT without verifying it; null for anything that is not a JWT. */
        fun decode(token: String): TokenClaims? {
            val parts = token.split('.')
            if (parts.size != 3 || parts[1].isEmpty()) return null
            return runCatching {
                val payload = String(Base64.getUrlDecoder().decode(parts[1].trimEnd('=')), Charsets.UTF_8)
                val obj = json.parseToJsonElement(payload).jsonObject
                TokenClaims(
                    sub = obj["sub"]?.jsonPrimitive?.content,
                    acct = obj["acct"]?.jsonPrimitive?.content?.takeIf { it.isNotEmpty() },
                    dl = obj["dl"]?.jsonPrimitive?.booleanOrNull == true,
                    exp = obj["exp"]?.jsonPrimitive?.longOrNull
                )
            }.getOrNull()
        }
    }
}
