package app.shareanywhere.account.crypto

import app.shareanywhere.data.api.ChainLink
import app.shareanywhere.data.api.DeviceKey
import app.shareanywhere.data.api.KeyChain
import app.shareanywhere.data.api.KeyVersionInfo
import app.shareanywhere.data.api.PairingStatus
import app.shareanywhere.data.api.PendingBlob
import app.shareanywhere.data.api.RecoveryBlob
import app.shareanywhere.data.api.RecoveryInfo
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The key flows against a simulated honest server (and a few dishonest answers), as the Web's flows.test.ts. */
class KeyFlowsTest {
    /** What the server keeps after setup and rotations. */
    private class Server {
        var setup: app.shareanywhere.data.api.KeysSetupRequest? = null
        val versions = mutableListOf<KeyVersionInfo>()
        val chain = mutableListOf<ChainLink>()
        var recoveryBlob = ""
        var keyVersion = 0
        val devices = mutableListOf<DeviceKey>()

        fun chainState() = KeyChain(chain.toList(), versions.toList())

        fun recovery() = RecoveryBlob(keyVersion, recoveryBlob, setup!!.salt, setup!!.params, setup!!.recoveryAnchor)

        fun recoveryInfo() = RecoveryInfo(setup!!.recoveryPublicKey, setup!!.salt, setup!!.params, setup!!.recoveryKeySignature)
    }

    private fun expect(code: String, block: suspend () -> Unit) = runBlocking {
        try {
            block()
            fail("expected $code")
        } catch (e: CryptoException) {
            assertEquals(code, e.code)
        }
    }

    private suspend fun setupAccount(server: Server, store: KeyStore): String {
        val prepared = KeyFlows.prepareSetup(store)
        server.setup = prepared.request
        server.versions += KeyVersionInfo(1, prepared.request.verifyKey, null)
        server.recoveryBlob = prepared.request.recoveryBlob
        server.keyVersion = 1
        prepared.commit(store)
        return prepared.phrase
    }

    @Test
    fun setupThenRecoverOnANewDevice() = runBlocking {
        val server = Server()
        val first = MemoryKeyStore()
        val phrase = setupAccount(server, first)
        assertEquals(12, phrase.split(' ').size)
        val second = MemoryKeyStore()
        assertEquals(1, KeyFlows.recover(second, phrase.uppercase(), server.recovery(), server.chainState(), server.recoveryInfo()))
        assertArrayEquals(first.adk(1), second.adk(1))
        // A well-formed but wrong phrase fails as a decryption error.
        expect("decrypt_failed") {
            KeyFlows.recover(MemoryKeyStore(), Phrase.generate(), server.recovery(), server.chainState(), server.recoveryInfo())
        }
        // A server listing another recovery key than the phrase derives is refused.
        val other = server.recoveryInfo().copy(publicKey = B64u.encode(Primitives.x25519PublicKey(Primitives.random(32))))
        expect("recovery_unverified") { KeyFlows.recover(MemoryKeyStore(), phrase, server.recovery(), server.chainState(), other) }
    }

    @Test
    fun pairingDeliversTheKeyOnlyThroughTheFingerprint() = runBlocking {
        val server = Server()
        val existing = MemoryKeyStore()
        setupAccount(server, existing)
        val existingPub = B64u.encode(Primitives.x25519PublicKey(existing.devicePrivateKey()))
        val ephemeral = Primitives.clamp(Primitives.random(32))
        val ephemeralPub = B64u.encode(Primitives.x25519PublicKey(ephemeral))
        val payload = KeyFlows.pairingPayload("ABC123", ephemeralPub)
        val (code, fp) = KeyFlows.parsePairingPayload(payload)!!
        assertEquals("ABC123", code)
        // A server that swaps in its own ephemeral key fails the fingerprint check.
        val swapped = B64u.encode(Primitives.x25519PublicKey(Primitives.random(32)))
        expect("untrusted_sender") { KeyFlows.wrapForPairing(existing, swapped, fp) }
        val wrap = KeyFlows.wrapForPairing(existing, ephemeralPub, fp)
        val ready = PairingStatus("ready", wrap.keyVersion, wrap.senderPublicKey, wrap.blob)
        // A sender that is not a registered device of the account is refused.
        expect("untrusted_sender") { KeyFlows.acceptPairing(MemoryKeyStore(), ephemeral, ready, server.chainState(), listOf("not-it")) }
        val newcomer = MemoryKeyStore()
        assertEquals(1, KeyFlows.acceptPairing(newcomer, ephemeral, ready, server.chainState(), listOf(existingPub)))
        assertArrayEquals(existing.adk(1), newcomer.adk(1))
        assertEquals(null, KeyFlows.parsePairingPayload("sa2.x.y"))
        assertEquals(null, KeyFlows.parsePairingPayload("sa1.a b.$fp"))
    }

    @Test
    fun rotationReachesProvenDevicesAndPickupChecksTheChain() = runBlocking {
        val server = Server()
        val a = MemoryKeyStore()
        setupAccount(server, a)
        val b = MemoryKeyStore()
        b.save(1, a.adk(1))
        val idA = "00000000-0000-4000-8000-00000000000a"
        val idB = "00000000-0000-4000-8000-00000000000b"
        val idC = "00000000-0000-4000-8000-00000000000c"
        val proofA = KeyFlows.proveDeviceKey(a, idA)
        val proofB = KeyFlows.proveDeviceKey(b, idB)
        server.devices += DeviceKey(idA, proofA.publicKey, 1, proofA.proof)
        server.devices += DeviceKey(idB, proofB.publicKey, 1, proofB.proof)
        // C registered a key with a forged proof: it gets nothing.
        server.devices += DeviceKey(idC, B64u.encode(Primitives.x25519PublicKey(Primitives.random(32))), 1, proofB.proof)
        val rotation = KeyFlows.prepareRotation(a, 1, server.recoveryInfo(), server.devices, exclude = listOf())
        assertEquals(listOf(idC to KeyFlows.Skip.Unproven), rotation.skipped)
        assertEquals(setOf(idA, idB), rotation.request.deviceBlobs.map { it.deviceId }.toSet())
        // The server stores the rotation.
        server.versions += KeyVersionInfo(2, rotation.request.verifyKey, rotation.request.signature)
        server.chain += ChainLink(2, rotation.request.chainBlob)
        server.recoveryBlob = rotation.request.recoveryBlob
        server.keyVersion = 2
        rotation.commit(a)
        val blobB = rotation.request.deviceBlobs.single { it.deviceId == idB }.blob
        val picked = KeyFlows.acceptPendingBlobs(b, listOf(PendingBlob(2, blobB, idA)), server.chainState())
        assertEquals(listOf(2), picked.accepted)
        assertArrayEquals(a.adk(2), b.adk(2))
        // A blob someone with only the password made (no chain link to the held key) is refused.
        val forged = Wrap.wrap(Primitives.random(32), Primitives.random(32), Primitives.x25519PublicKey(b.devicePrivateKey()), "rotate", 3)
        val bad = KeyFlows.acceptPendingBlobs(b, listOf(PendingBlob(3, B64u.encode(forged), idA)), server.chainState())
        assertTrue(bad.accepted.isEmpty() && bad.failed.single().first == 3)
        // The phrase still opens the newest key (recovery blob re-wrapped by the rotation), fully anchored.
        val c = MemoryKeyStore()
        assertTrue(server.recovery().keyVersion == 2)
        // Chain import: a device holding only ADK(2) walks down to ADK(1).
        val d = MemoryKeyStore()
        d.save(2, a.adk(2))
        assertEquals(listOf(1), KeyFlows.importChain(d, server.chainState()))
        assertArrayEquals(a.adk(1), d.adk(1))
        assertEquals(0, c.current())
    }

    @Test
    fun aDeviceHoldingKeysIsAnchoredOnThem() = runBlocking {
        val server = Server()
        val a = MemoryKeyStore()
        setupAccount(server, a)
        // A fabricated account (another ADK v1 and verify key) is refused by a device that holds the real ADK(1).
        val fake = Primitives.random(32)
        val fakeChain = KeyChain(emptyList(), listOf(KeyVersionInfo(1, B64u.encode(Authenticity.verifyKey(fake)), null)))
        expect("unverified") { Verify.assertAnchoredOnHeld(a, fakeChain, 1, fake) }
        // Rolling back to an older version than held is refused.
        a.save(2, Primitives.random(32))
        expect("unverified") { Verify.assertAnchoredOnHeld(a, server.chainState(), 1, a.adk(1)) }
    }

    @Test
    fun rotationRefusesAnUnsignedRecoveryKeyAndVersionMismatch() = runBlocking {
        val server = Server()
        val a = MemoryKeyStore()
        setupAccount(server, a)
        val unsigned = server.recoveryInfo().copy(signature = null)
        expect("keys_legacy") { KeyFlows.prepareRotation(a, 1, unsigned, emptyList()) }
        val wrongKey = server.recoveryInfo().copy(publicKey = B64u.encode(Primitives.x25519PublicKey(Primitives.random(32))))
        expect("unverified") { KeyFlows.prepareRotation(a, 1, wrongKey, emptyList()) }
        expect("not_found") { KeyFlows.prepareRotation(a, 2, server.recoveryInfo(), emptyList()) }
        // Stale and excluded devices are skipped.
        val id = "00000000-0000-4000-8000-0000000000ee"
        val stale = DeviceKey(id, B64u.encode(Primitives.x25519PublicKey(Primitives.random(32))), 0, "AA")
        val r = KeyFlows.prepareRotation(
            a,
            1,
            server.recoveryInfo(),
            listOf(stale, DeviceKey("00000000-0000-4000-8000-0000000000ef", null, null, null)),
            exclude = listOf()
        )
        assertEquals(listOf(KeyFlows.Skip.Stale, KeyFlows.Skip.NoKey), r.skipped.map { it.second })
        r.discard()
        val ex = KeyFlows.prepareRotation(a, 1, server.recoveryInfo(), listOf(stale), exclude = listOf(id.uppercase()))
        assertEquals(KeyFlows.Skip.Excluded, ex.skipped.single().second)
        ex.discard()
    }

    @Test
    fun theStoreRefusesDifferentBytesForAVersion() = runBlocking {
        val s = MemoryKeyStore()
        val k = Primitives.random(32)
        s.save(1, k)
        s.save(1, k)
        expect("invalid_input") { s.save(1, Primitives.random(32)) }
    }
}
