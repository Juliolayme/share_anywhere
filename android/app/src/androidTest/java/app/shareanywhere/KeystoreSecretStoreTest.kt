package app.shareanywhere

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.shareanywhere.identity.KeystoreSecretStore
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** The refresh secret is stored encrypted with an AndroidKeyStore key (docs/SECURITY_MODEL.md §4). */
@RunWith(AndroidJUnit4::class)
class KeystoreSecretStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun roundTripsWithoutPlaintextOnDisk() = runBlocking {
        val store = KeystoreSecretStore(context)
        store.clear()
        assertNull(store.read())
        val secret = "test-refresh-value"
        store.write(secret)
        assertEquals(secret, store.read())
        val file = File(context.noBackupFilesDir, "device_refresh.bin")
        assertFalse(String(file.readBytes(), Charsets.ISO_8859_1).contains(secret))
        store.write("rotated")
        assertEquals("rotated", KeystoreSecretStore(context).read())
        store.clear()
        assertNull(store.read())
    }

    @Test
    fun aCorruptBlobIsDiscarded() = runBlocking {
        val store = KeystoreSecretStore(context)
        store.write("value")
        File(context.noBackupFilesDir, "device_refresh.bin").writeBytes(byteArrayOf(1, 12) + ByteArray(40))
        assertNull(store.read())
    }
}
