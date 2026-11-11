package app.shareanywhere.account.crypto

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The Android key library reproduces shared/protocol/schemas/clipboard-vectors.json (docs/CLIPBOARD_PROTOCOL.md §1.12). */
class CryptoVectorsTest {
    private val root = File(requireNotNull(System.getProperty("sa.repoRoot")))
    private val v: JsonObject = Json.parseToJsonElement(File(root, "shared/protocol/schemas/clipboard-vectors.json").readText()).jsonObject

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    private fun JsonObject.o(k: String) = this[k]!!.jsonObject

    private fun hx(s: String) = ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }

    @Test
    fun adkSubkeysAndItems() {
        val a = v.o("adk")
        val adk = hx(a.s("adk"))
        assertEquals(a.o("subkeys").s("clipboard"), Adk.subkey(adk, Adk.CLIPBOARD).toHex())
        assertEquals(a.o("subkeys").s("history"), Adk.subkey(adk, Adk.HISTORY).toHex())
        for (it in v.o("items")["vectors"]!!.jsonArray.map { e -> e.jsonObject }) {
            val sub = Adk.subkey(adk, if (it.s("subkey") == "history") Adk.HISTORY else Adk.CLIPBOARD)
            val kv = it["key_version"]!!.jsonPrimitive.int
            assertEquals(it.s("aad_utf8"), Items.aad(it.s("id"), kv).toHex())
            val enc = Items.encrypt(sub, it.s("id"), kv, hx(it.s("plaintext_utf8")), hx(it.s("nonce")))
            assertEquals(it.s("ciphertext"), enc.ciphertext.toHex())
            assertEquals(it.s("ciphertext_b64u"), B64u.encode(enc.ciphertext))
            assertEquals(it.s("plaintext_utf8"), Items.decrypt(sub, it.s("id"), kv, enc).toHex())
            // The AAD binds the row and the version.
            try {
                Items.decrypt(sub, it.s("id"), kv + 1, enc)
                fail("decrypted under another version")
            } catch (e: CryptoException) {
                assertEquals("decrypt_failed", e.code)
            }
        }
    }

    @Test
    fun wrapAndChain() {
        val w = v.o("wrap")
        assertEquals(w.s("recipient_private_clamped"), Primitives.clamp(hx(w.s("recipient_private"))).toHex())
        assertEquals(w.s("recipient_public"), Primitives.x25519PublicKey(hx(w.s("recipient_private"))).toHex())
        assertEquals(w.s("sender_public"), Primitives.x25519PublicKey(hx(w.s("sender_private"))).toHex())
        val shared = Primitives.x25519(hx(w.s("sender_private")), hx(w.s("recipient_public")))
        assertEquals(w.s("shared_secret"), shared.toHex())
        assertEquals(w.s("wrap_key"), Wrap.wrapKey(shared, hx(w.s("sender_public")), hx(w.s("recipient_public"))).toHex())
        for (it in w["vectors"]!!.jsonArray.map { e -> e.jsonObject }) {
            val kv = it["key_version"]!!.jsonPrimitive.int
            val blob = Wrap.wrap(
                hx(w.s("adk")),
                hx(w.s("sender_private")),
                hx(w.s("recipient_public")),
                it.s("purpose"),
                kv,
                hx(w.s("nonce"))
            )
            assertEquals(it.s("blob"), blob.toHex())
            assertEquals(it.s("blob_b64u"), B64u.encode(blob))
            assertEquals(w.s("adk"), Wrap.unwrap(blob, hx(w.s("recipient_private")), it.s("purpose"), kv).toHex())
            assertArrayEquals(hx(w.s("sender_public")), Wrap.senderPublicKey(blob))
        }
        val c = v.o("chain")
        val chain = Wrap.wrapChain(hx(c.s("adk_v1")), hx(c.s("adk_v2")), 2, hx(c.s("nonce")))
        assertEquals(c.s("blob"), chain.toHex())
        assertEquals(c.s("adk_v1"), Wrap.unwrapChain(chain, hx(c.s("adk_v2")), 2).toHex())
        // A rotation blob is not a pairing blob (purpose in the AAD), and a low-order key is refused.
        val rotate = Wrap.wrap(hx(w.s("adk")), hx(w.s("sender_private")), hx(w.s("recipient_public")), "rotate", 2)
        try {
            Wrap.unwrap(rotate, hx(w.s("recipient_private")), "pair", 2)
            fail()
        } catch (_: CryptoException) {
        }
        try {
            Primitives.x25519(hx(w.s("sender_private")), ByteArray(32))
            fail()
        } catch (e: CryptoException) {
            assertEquals("invalid_key", e.code)
        }
    }

    @Test
    fun recoveryPhraseAndArgon2id() {
        val r = v.o("recovery")
        assertEquals(r.s("phrase"), Phrase.fromEntropy(hx(r.s("entropy"))))
        assertEquals(r.s("normalized"), Phrase.normalize(r.s("typed_input")))
        assertNull(Phrase.check(r.s("typed_input")))
        assertEquals(r.s("entropy"), Phrase.toEntropy(r.s("phrase")).toHex())
        val a = r.o("argon2id")
        val params = Primitives.ArgonParams(a["m"]!!.jsonPrimitive.int, a["t"]!!.jsonPrimitive.int, a["p"]!!.jsonPrimitive.int)
        val d = Recovery.derive(r.s("typed_input"), hx(a.s("salt")), params)
        assertEquals(r.s("seed"), d.seed.toHex())
        assertEquals(r.s("private_clamped"), d.privateKey.toHex())
        assertEquals(r.s("public_key"), d.publicKey.toHex())
        assertEquals(r.s("public_key_b64u"), B64u.encode(d.publicKey))
    }

    @Test
    fun phraseProblemsAreNamed() {
        val words = Phrase.fromEntropy(ByteArray(16) { 0x7f }).split(' ')
        assertEquals("word_count", Phrase.check(words.take(11).joinToString(" "))!!.reason)
        assertEquals(Phrase.Problem("unknown_word", "zzzz"), Phrase.check((words.take(11) + "zzzz").joinToString(" ")))
        val swapped = (words.take(11) + if (words[11] == "abandon") "ability" else "abandon").joinToString(" ")
        assertEquals("checksum", Phrase.check(swapped)!!.reason)
        assertEquals(12, Phrase.generate().split(' ').size)
    }

    @Test
    fun keyAuthenticity() {
        val k = v.o("key_authenticity")
        val c = v.o("chain")
        val adk1 = hx(c.s("adk_v1"))
        val adk2 = hx(c.s("adk_v2"))
        assertEquals(k.s("sign_seed_v1"), Authenticity.signSeed(adk1).toHex())
        assertEquals(k.s("verify_key_v1"), Authenticity.verifyKey(adk1).toHex())
        assertEquals(k.s("sign_seed_v2"), Authenticity.signSeed(adk2).toHex())
        assertEquals(k.s("verify_key_v2"), Authenticity.verifyKey(adk2).toHex())
        val rot = k.o("rotation")
        val chain = hx(c.s("blob"))
        assertEquals(rot.s("chain_blob_sha256"), Primitives.sha256(chain).toHex())
        val msg = Authenticity.rotationMessage(2, Authenticity.verifyKey(adk2), chain)
        assertEquals(rot.s("message_utf8"), msg)
        assertEquals(rot.s("signature"), Authenticity.sign(adk1, msg).toHex())
        assertTrue(Authenticity.verify(hx(rot.s("signature")), msg, Authenticity.verifyKey(adk1)))
        assertFalse(Authenticity.verify(hx(rot.s("signature")), msg, Authenticity.verifyKey(adk2)))
        val dk = k.o("device_key")
        val dmsg = Authenticity.deviceKeyMessage(dk.s("device_id"), dk["key_version"]!!.jsonPrimitive.int, hx(dk.s("public_key")))
        assertEquals(dk.s("message_utf8"), dmsg)
        assertEquals(dk.s("proof"), Authenticity.sign(adk1, dmsg).toHex())
        val an = k.o("anchor")
        val anchorKey = Authenticity.anchorKey(hx(an.s("recovery_seed")))
        assertEquals(an.s("anchor_key"), anchorKey.toHex())
        assertEquals(an.s("message_utf8"), Authenticity.anchorMessage(hx(k.s("verify_key_v1"))))
        assertEquals(an.s("recovery_anchor"), Authenticity.recoveryAnchor(anchorKey, hx(k.s("verify_key_v1"))).toHex())
        val rk = k.o("recovery_key")
        val rmsg = Authenticity.recoveryKeyMessage(hx(rk.s("public_key")))
        assertEquals(rk.s("message_utf8"), rmsg)
        assertEquals(rk.s("signature"), Authenticity.sign(adk1, rmsg).toHex())
    }

    @Test
    fun base64urlIsStrict() {
        assertEquals("AQID", B64u.encode(byteArrayOf(1, 2, 3)))
        assertArrayEquals(byteArrayOf(1, 2, 3), B64u.decode("AQID"))
        assertArrayEquals(byteArrayOf(-1, -2), B64u.decode("__4"))
        for (bad in listOf("AQID=", "AQ+D", "A", "AR")) {
            try {
                B64u.decode(bad)
                fail("accepted $bad")
            } catch (e: CryptoException) {
                assertEquals("invalid_encoding", e.code)
            }
        }
        val all = ByteArray(256) { it.toByte() }
        assertArrayEquals(all, B64u.decode(B64u.encode(all)))
    }

    @Test
    fun theWordlistIsTheWebOne() {
        val web = File(root, "web/src/lib/crypto/bip39-english.txt").readLines().map { it.trim() }.filter { it.isNotEmpty() }
        assertEquals(web, Phrase.wordlist)
    }

    @Test
    fun historyIdsAreVersion8Uuids() {
        val id = Items.itemIdFromBytes(Primitives.sha256("x".toByteArray()))
        assertTrue(Items.isItemId(id))
        assertEquals('8', id[14])
        assertTrue(id[19] in "89ab")
    }
}
