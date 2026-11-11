package app.shareanywhere.account.crypto

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.math.ec.rfc7748.X25519
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** A cryptographic failure, reported with one code and no detail (docs/CLIPBOARD_PROTOCOL.md §1.3). */
class CryptoException(val code: String, message: String = code) : Exception(message)

/**
 * The primitives of the account-key protocol (docs/CLIPBOARD_PROTOCOL.md §1, docs/ADR/0021-android-crypto.md):
 * SHA-256, HMAC, HKDF-SHA256, AES-256-GCM (platform JCA), X25519 and Ed25519 (RFC 7748 / 8032) and Argon2id
 * (BouncyCastle). Byte for byte the Web's `web/src/lib/crypto`, checked by clipboard-vectors.json.
 */
object Primitives {
    const val KEY_BYTES = 32
    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16
    private val rng = SecureRandom()

    fun random(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(data)
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = KEY_BYTES): ByteArray {
        val g = HKDFBytesGenerator(SHA256Digest())
        // An empty salt means HashLen zero bytes (RFC 5869), as WebCrypto's HKDF does.
        g.init(HKDFParameters(ikm, if (salt.isEmpty()) null else salt, info))
        return ByteArray(length).also { g.generateBytes(it, 0, length) }
    }

    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
        require(key.size == KEY_BYTES && nonce.size == NONCE_BYTES) { "AES-256-GCM key or nonce size" }
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
            updateAAD(aad)
            doFinal(plaintext)
        }
    }

    /** Opens AES-256-GCM; any failure is the single `decrypt_failed` error. */
    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, sealed: ByteArray, aad: ByteArray): ByteArray {
        if (key.size != KEY_BYTES || nonce.size != NONCE_BYTES || sealed.size < TAG_BYTES) throw CryptoException("decrypt_failed")
        return try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
                updateAAD(aad)
                doFinal(sealed)
            }
        } catch (_: AEADBadTagException) {
            throw CryptoException("decrypt_failed")
        } catch (_: java.security.GeneralSecurityException) {
            throw CryptoException("decrypt_failed")
        }
    }

    /** RFC 7748 clamping of an X25519 scalar (copy). */
    fun clamp(scalar: ByteArray): ByteArray {
        require(scalar.size == KEY_BYTES) { "X25519 scalar size" }
        return scalar.copyOf().also {
            it[0] = (it[0].toInt() and 248).toByte()
            it[31] = ((it[31].toInt() and 127) or 64).toByte()
        }
    }

    fun x25519PublicKey(privateKey: ByteArray): ByteArray = ByteArray(KEY_BYTES).also { X25519.scalarMultBase(clamp(privateKey), 0, it, 0) }

    /** X25519(priv, pub), rejecting an all-zero result (low-order public key, §1.11). */
    fun x25519(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        if (publicKey.size != KEY_BYTES) throw CryptoException("invalid_key")
        val out = ByteArray(KEY_BYTES)
        X25519.scalarMult(clamp(privateKey), 0, publicKey, 0, out, 0)
        if (out.all { it.toInt() == 0 }) throw CryptoException("invalid_key", "low-order X25519 public key")
        return out
    }

    fun ed25519PublicKey(seed: ByteArray): ByteArray = ByteArray(Ed25519.PUBLIC_KEY_SIZE).also { Ed25519.generatePublicKey(seed, 0, it, 0) }

    fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray = ByteArray(Ed25519.SIGNATURE_SIZE).also {
        Ed25519.sign(seed, 0, message, 0, message.size, it, 0)
    }

    /** Strict RFC 8032 verification (canonical encodings, no ZIP-215 leniency). */
    fun ed25519Verify(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean {
        if (signature.size != Ed25519.SIGNATURE_SIZE || publicKey.size != Ed25519.PUBLIC_KEY_SIZE) return false
        return try {
            Ed25519.verify(signature, 0, publicKey, 0, message, 0, message.size)
        } catch (_: RuntimeException) {
            false
        }
    }

    data class ArgonParams(val m: Int, val t: Int, val p: Int)

    /** Accepted server-supplied Argon2id parameters (§1.6): weaker would ease guessing, larger could exhaust the device. */
    fun checkArgon(params: ArgonParams, salt: ByteArray) {
        if (params.m !in 65536..262144 || params.t !in 3..10 || params.p !in 1..4 || salt.size != 16) {
            throw CryptoException("invalid_params", "Argon2id parameters out of range")
        }
    }

    fun argon2id(password: ByteArray, salt: ByteArray, params: ArgonParams, length: Int = KEY_BYTES): ByteArray {
        val p =
            Argon2Parameters
                .Builder(Argon2Parameters.ARGON2_id)
                .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                .withMemoryAsKB(params.m)
                .withIterations(params.t)
                .withParallelism(params.p)
                .withSalt(salt)
                .build()
        val g = Argon2BytesGenerator().apply { init(p) }
        return ByteArray(length).also { g.generateBytes(password, it) }
    }

    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    fun zero(vararg arrays: ByteArray?) = arrays.forEach { it?.fill(0) }
}

/** Base64url without padding, strict (§1.10): no padding, no other alphabet, no non-canonical trailing bits. */
object B64u {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val INDEX = IntArray(128) { -1 }.also { t -> ALPHABET.forEachIndexed { i, c -> t[c.code] = i } }

    fun encode(bytes: ByteArray): String = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(text: String): ByteArray {
        if (text.length % 4 == 1) throw CryptoException("invalid_encoding", "base64url: impossible length")
        val out = ByteArray(text.length * 3 / 4)
        var o = 0
        var acc = 0
        var bits = 0
        for (c in text) {
            val v = if (c.code < 128) INDEX[c.code] else -1
            if (v < 0) throw CryptoException("invalid_encoding", "base64url: invalid character")
            acc = (acc shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out[o++] = ((acc shr bits) and 0xFF).toByte()
            }
            acc = acc and ((1 shl bits) - 1) // keep only the bits not yet emitted
        }
        if (bits > 0 && (acc and ((1 shl bits) - 1)) != 0) throw CryptoException("invalid_encoding", "base64url: non-canonical encoding")
        return out.copyOf(o)
    }
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xFF) }
