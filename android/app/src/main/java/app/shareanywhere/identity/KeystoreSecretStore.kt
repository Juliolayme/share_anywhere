package app.shareanywhere.identity

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.util.AtomicFile
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Refresh secret encrypted with an AES-256-GCM key that never leaves AndroidKeyStore (docs/SECURITY_MODEL.md §4).
 * The ciphertext sits in `noBackupFilesDir`, and backups exclude app data (data_extraction_rules.xml), so the
 * secret cannot be restored on another device; a copy would not decrypt there anyway.
 *
 * File format: version (1 byte) | IV length (1 byte) | IV | ciphertext+tag. The AAD binds the blob to its purpose.
 * A blob that fails to decrypt (key invalidated, data restored from elsewhere, corruption) is deleted, which
 * makes the app create a new anonymous identity.
 */
class KeystoreSecretStore(context: Context) : SecretStore {
    private val file = AtomicFile(File(context.noBackupFilesDir, FILE_NAME))
    private val aad = "sa-refresh-v1|${context.packageName}".toByteArray(Charsets.UTF_8)

    override suspend fun read(): String? = withContext(Dispatchers.IO) {
        val blob = runCatching { file.readFully() }.getOrNull() ?: return@withContext null
        try {
            require(blob.size > 2 && blob[0] == VERSION) { "unknown format" }
            val ivLen = blob[1].toInt()
            require(ivLen in 12..16 && blob.size > 2 + ivLen) { "bad iv" }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, blob, 2, ivLen))
            cipher.updateAAD(aad)
            String(cipher.doFinal(blob, 2 + ivLen, blob.size - 2 - ivLen), Charsets.UTF_8)
        } catch (e: GeneralSecurityException) {
            file.delete()
            null
        } catch (e: IllegalArgumentException) {
            file.delete()
            null
        }
    }

    override suspend fun write(secret: String) = withContext(Dispatchers.IO) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(aad)
        val iv = cipher.iv
        val ct = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        val out = file.startWrite()
        try {
            out.write(byteArrayOf(VERSION, iv.size.toByte()))
            out.write(iv)
            out.write(ct)
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    override suspend fun clear() = withContext(Dispatchers.IO) { file.delete() }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec
                .Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_BITS)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "sa_device_refresh_v1"
        const val FILE_NAME = "device_refresh.bin"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val KEY_BITS = 256
        const val VERSION: Byte = 1
    }
}
