package app.shareanywhere.transfer.cloud

import app.shareanywhere.account.crypto.B64u
import app.shareanywhere.account.crypto.Primitives
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Android cloud crypto reproduces shared/protocol/schemas/cloud-vectors.json, as the Web and iOS do. */
class CloudVectorsTest {
    private val root = File(requireNotNull(System.getProperty("sa.repoRoot")) { "sa.repoRoot is set by app/build.gradle.kts" })
    private val v: JsonObject = Json.parseToJsonElement(File(root, "shared/protocol/schemas/cloud-vectors.json").readText()).jsonObject

    private fun JsonObject.s(k: String) = getValue(k).jsonPrimitive.content

    @Test
    fun partsMatchTheSharedVectors() {
        val p = v.getValue("part").jsonObject
        val key = hexBytes(p.s("key"))
        val oid = p.s("object_id")
        val count = p.getValue("part_count").jsonPrimitive.int
        for (part in p.getValue("parts").jsonArray.map { it.jsonObject }) {
            val n = part.getValue("n").jsonPrimitive.int
            val plain = hexBytes(part.s("plaintext"))
            val stored = CloudCrypto.sealPart(key, oid, n, count, plain, hexBytes(part.s("nonce")))
            assertEquals("part $n", part.s("stored"), stored.joinToString("") { "%02x".format(it) })
            assertArrayEquals(plain, CloudCrypto.openPart(key, oid, n, count, stored))
            assertThrows(CloudException::class.java) { CloudCrypto.openPart(key, oid, n + 1, count, stored) }
            assertThrows(CloudException::class.java) { CloudCrypto.openPart(key, oid, n, count + 1, stored) }
            val bad = stored.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
            assertThrows(CloudException::class.java) { CloudCrypto.openPart(key, oid, n, count, bad) }
        }
    }

    @Test
    fun keyWrapMatchesTheSharedVectors() {
        val p = v.getValue("part").jsonObject
        val w = v.getValue("wrap").jsonObject
        val receiver = hexBytes(w.s("receiver_private"))
        val sender = hexBytes(w.s("sender_private"))
        assertEquals(w.s("receiver_public_b64u"), B64u.encode(Primitives.x25519PublicKey(receiver)))
        assertEquals(w.s("sender_public_b64u"), B64u.encode(Primitives.x25519PublicKey(sender)))
        val key = CloudObjectKey(w.s("object_id"), w.s("file_id"), hexBytes(p.s("key")), hexBytes(p.s("file_sha256")))
        val payload =
            CloudCrypto.wrapKeys(
                listOf(key),
                w.s("receiver_public_b64u"),
                w.s("session_id"),
                w.s("receiver_participant_id"),
                sender,
                listOf(B64u.decode(w.s("nonce_b64u")))
            )
        assertEquals(w.s("sender_public_b64u"), payload.publicKey)
        assertEquals(w.s("wrapped_b64u"), payload.keys.single().wrapped)
        val back = CloudCrypto.unwrapKeys(payload, receiver, w.s("session_id"), w.s("receiver_participant_id")).single()
        assertArrayEquals(key.key, back.key)
        assertArrayEquals(key.sha256, back.sha256)
        assertTrue(CloudCrypto.unwrapKeys(payload, Primitives.random(32), w.s("session_id"), "x").isEmpty())
    }
}
