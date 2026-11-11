package app.shareanywhere.account.keys

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import app.shareanywhere.account.crypto.B64u
import app.shareanywhere.account.crypto.CryptoException
import app.shareanywhere.account.crypto.KeyStore
import app.shareanywhere.account.crypto.Primitives
import java.io.File
import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Seals small secrets with a key the app cannot read out (Android Keystore on devices; memory in JVM tests). */
interface Sealer {
    fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray

    /** Throws [CryptoException] `decrypt_failed` when the blob cannot be opened (key invalidated, foreign data). */
    fun open(blob: ByteArray, aad: ByteArray): ByteArray
}

/** AES-256-GCM with a non-exportable AndroidKeyStore key (docs/CLIPBOARD_PROTOCOL.md §1.9, PRD §7.5). */
class KeystoreSealer(private val alias: String = "sa_account_keys_v1") : Sealer {
    private fun key(): SecretKey {
        val ks = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(
            KeyGenParameterSpec
                .Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return g.generateKey()
    }

    override fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        c.updateAAD(aad)
        val iv = c.iv
        return byteArrayOf(iv.size.toByte()) + iv + c.doFinal(plaintext)
    }

    override fun open(blob: ByteArray, aad: ByteArray): ByteArray = try {
        val ivLen = blob[0].toInt()
        require(ivLen in 12..16 && blob.size > 1 + ivLen)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 1, ivLen))
        c.updateAAD(aad)
        c.doFinal(blob, 1 + ivLen, blob.size - 1 - ivLen)
    } catch (_: GeneralSecurityException) {
        throw CryptoException("decrypt_failed")
    } catch (_: IllegalArgumentException) {
        throw CryptoException("decrypt_failed")
    } catch (_: IndexOutOfBoundsException) {
        throw CryptoException("decrypt_failed")
    }
}

@Serializable
private data class Stored(val account: String, val adks: Map<String, String> = emptyMap(), val device: String? = null)

/**
 * The account's keys on this device (docs/CLIPBOARD_PROTOCOL.md §1.9): every ADK version and the X25519 device wrapping
 * key, each sealed by [Sealer] with an AAD naming what it is (`adk|<v>`, `device|x25519`) and the account, in one file
 * under `noBackupFilesDir` (never backed up or restored elsewhere). Bound to one account: another account's file is
 * erased. Sign-out erases it.
 */
class AccountKeyStore(
    context: Context,
    private val sealer: Sealer = KeystoreSealer(),
    private val json: Json = Json {
        ignoreUnknownKeys =
            true
    }
) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "account_keys.json"))
    private val lock = Mutex()

    private suspend fun read(): Stored? = withContext(Dispatchers.IO) {
        runCatching { json.decodeFromString(Stored.serializer(), String(file.readFully())) }.getOrNull()
    }

    private suspend fun write(s: Stored) = withContext(Dispatchers.IO) {
        val out = file.startWrite()
        try {
            out.write(json.encodeToString(Stored.serializer(), s).toByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    suspend fun clear() = lock.withLock { withContext(Dispatchers.IO) { file.delete() } }

    /** The keys of [accountId]; a file for another account is erased first. */
    fun forAccount(accountId: String): KeyStore = object : KeyStore {
        private suspend fun state(): Stored {
            val s = read()
            if (s != null && s.account == accountId) return s
            return Stored(accountId).also { write(it) }
        }

        private fun adkAad(v: Int) = "adk|$v|$accountId".toByteArray()

        private val deviceAad = "device|x25519|$accountId".toByteArray()

        override suspend fun versions(): List<Int> = lock.withLock { state().adks.keys.mapNotNull { it.toIntOrNull() }.sorted() }

        override suspend fun adk(v: Int): ByteArray = lock.withLock {
            val blob = state().adks[v.toString()] ?: throw CryptoException("not_found", "no ADK version $v")
            sealer.open(B64u.decode(blob), adkAad(v))
        }

        override suspend fun save(v: Int, adk: ByteArray) = lock.withLock {
            val s = state()
            s.adks[v.toString()]?.let { existing ->
                val held = sealer.open(B64u.decode(existing), adkAad(v))
                try {
                    if (!Primitives.constantTimeEquals(
                            held,
                            adk
                        )
                    ) {
                        throw CryptoException("invalid_input", "different bytes for stored version $v")
                    }
                } finally {
                    Primitives.zero(held)
                }
                return@withLock
            }
            write(s.copy(adks = s.adks + (v.toString() to B64u.encode(sealer.seal(adk, adkAad(v))))))
        }

        override suspend fun devicePrivateKey(): ByteArray = lock.withLock {
            val s = state()
            s.device?.let { return@withLock sealer.open(B64u.decode(it), deviceAad) }
            val priv = Primitives.clamp(Primitives.random(32))
            write(s.copy(device = B64u.encode(sealer.seal(priv, deviceAad))))
            priv
        }

        override suspend fun clear() = this@AccountKeyStore.clear()
    }
}
