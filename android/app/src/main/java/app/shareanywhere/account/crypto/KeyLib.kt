package app.shareanywhere.account.crypto

import app.shareanywhere.data.api.Argon2Spec
import app.shareanywhere.data.api.DeviceBlob
import app.shareanywhere.data.api.DeviceKey
import app.shareanywhere.data.api.DeviceKeyRequest
import app.shareanywhere.data.api.KeyChain
import app.shareanywhere.data.api.KeyVersionInfo
import app.shareanywhere.data.api.KeysRotateRequest
import app.shareanywhere.data.api.KeysSetupRequest
import app.shareanywhere.data.api.PairingStatus
import app.shareanywhere.data.api.PairingWrapRequest
import app.shareanywhere.data.api.PendingBlob
import app.shareanywhere.data.api.RecoveryBlob
import app.shareanywhere.data.api.RecoveryInfo

/**
 * Where a device keeps its account keys (§1.9): every ADK version it holds and its X25519 device wrapping key.
 * The Android implementation wraps both with an Android Keystore key; tests use memory.
 */
interface KeyStore {
    suspend fun versions(): List<Int>

    suspend fun current(): Int = versions().maxOrNull() ?: 0

    suspend fun has(v: Int): Boolean = v in versions()

    /** A copy of ADK(v); the caller zeroes it. */
    suspend fun adk(v: Int): ByteArray

    /** Stores ADK(v); the same bytes again are a no-op, different bytes for a stored version are refused. */
    suspend fun save(v: Int, adk: ByteArray)

    /** The device wrapping private key, created on first use (a copy; the caller zeroes it). */
    suspend fun devicePrivateKey(): ByteArray

    suspend fun clear()
}

/** The account's chain and version list from `GET /v1/keys/chain`. */
typealias ChainState = KeyChain

private fun unverified(m: String) = CryptoException("unverified", m)

private fun legacy() = CryptoException("keys_legacy", "the account keys predate key authenticity and must be set up again")

/** The client rules of §1.13, the Kotlin twin of `web/src/lib/crypto/authenticity.ts`. */
object Verify {
    fun versionVerifyKey(versions: List<KeyVersionInfo>, v: Int): ByteArray {
        val row = versions.firstOrNull { it.keyVersion == v } ?: throw unverified("no verify key for version $v")
        val key = row.verifyKey ?: throw legacy()
        val bytes =
            try {
                B64u.decode(key)
            } catch (_: CryptoException) {
                throw unverified("malformed verify key for version $v")
            }
        if (bytes.size != 32) throw unverified("malformed verify key for version $v")
        return bytes
    }

    private fun chainBlob(state: ChainState, v: Int): ByteArray {
        val link = state.chain.firstOrNull { it.keyVersion == v } ?: throw unverified("no chain link for version $v")
        return try {
            B64u.decode(link.blob)
        } catch (_: CryptoException) {
            throw unverified("malformed chain link for version $v")
        }
    }

    /** Rotations start+1..upTo are each signed by the version before them, starting from [fromKey] (or verify_key(1)). */
    fun verifySignatureChain(state: ChainState, upTo: Int, fromVersion: Int = 1, fromKey: ByteArray? = null) {
        if (upTo < 1 || fromVersion < 1) throw CryptoException("invalid_input", "key version")
        if (fromVersion > upTo) throw unverified("version $upTo is older than the held version $fromVersion")
        var previous = fromKey?.copyOf() ?: versionVerifyKey(state.versions, 1)
        for (k in fromVersion + 1..upTo) {
            val current = versionVerifyKey(state.versions, k)
            val row = state.versions.firstOrNull { it.keyVersion == k }
            val sig =
                row?.signature
                    ?: if (row != null &&
                        row.signature == null &&
                        row.verifyKey != null
                    ) {
                        throw legacy()
                    } else {
                        throw unverified("version $k is unsigned")
                    }
            val signature =
                try {
                    B64u.decode(sig)
                } catch (_: CryptoException) {
                    throw unverified("malformed signature for version $k")
                }
            if (!Authenticity.verify(signature, Authenticity.rotationMessage(k, current, chainBlob(state, k)), previous)) {
                throw unverified("version $k is not signed by version ${k - 1}")
            }
            previous = current
        }
    }

    fun assertAdkMatchesVersion(adk: ByteArray, versions: List<KeyVersionInfo>, v: Int) {
        if (!Primitives.constantTimeEquals(Authenticity.verifyKey(adk), versionVerifyKey(versions, v))) {
            throw unverified("ADK version $v does not match the account's verify key")
        }
    }

    /** Anchors a server-supplied account on the keys held here before a received ADK(v) is stored (F.1). */
    suspend fun assertAnchoredOnHeld(store: KeyStore, state: ChainState, v: Int, received: ByteArray) {
        val held = store.versions()
        if (held.isEmpty()) return
        val k = held.max()
        if (v < k) throw unverified("version $v is older than the held version $k")
        var heldTop: ByteArray? = null
        var walked: ByteArray? = null
        try {
            var topVerifyKey: ByteArray? = null
            for (h in held) {
                val raw = store.adk(h)
                try {
                    val own = Authenticity.verifyKey(raw)
                    if (!Primitives.constantTimeEquals(own, versionVerifyKey(state.versions, h))) {
                        throw unverified("held ADK version $h does not match the account's verify key")
                    }
                    if (h == k) {
                        topVerifyKey = own
                        heldTop = raw.copyOf()
                    }
                } finally {
                    Primitives.zero(raw)
                }
            }
            if (topVerifyKey == null || heldTop == null) throw unverified("held ADK version $k is missing")
            verifySignatureChain(state, v, k, topVerifyKey)
            walked = received.copyOf()
            for (j in v downTo k + 1) {
                val next =
                    try {
                        Wrap.unwrapChain(chainBlob(state, j), walked!!, j)
                    } catch (e: CryptoException) {
                        if (e.code == "unverified") throw e
                        throw unverified("chain link $j does not open toward the held key")
                    }
                Primitives.zero(walked)
                walked = next
            }
            if (!Primitives.constantTimeEquals(walked!!, heldTop)) throw unverified("the received key does not lead to held version $k")
        } finally {
            Primitives.zero(heldTop, walked)
        }
    }

    /** Rotation pickup (A.6): chain link v opened with the candidate yields the held ADK(v-1), and the candidate derives verify_key(v). */
    fun assertRotationLink(candidate: ByteArray, heldPrevious: ByteArray, state: ChainState, v: Int) {
        if (v < 2) throw unverified("a rotation exists only for key_version >= 2")
        val opened =
            try {
                Wrap.unwrapChain(chainBlob(state, v), candidate, v)
            } catch (e: CryptoException) {
                if (e.code == "unverified") throw e
                throw unverified("chain link $v does not open with the new key")
            }
        try {
            if (!Primitives.constantTimeEquals(opened, heldPrevious)) throw unverified("chain link $v does not lead to the held key")
        } finally {
            Primitives.zero(opened)
        }
        assertAdkMatchesVersion(candidate, state.versions, v)
    }

    /** The recovery public key is signed by ADK v1 (ADR 0015); null is a legacy account. */
    fun assertRecoveryKeySigned(recoveryPublicKey: String, signature: String?, verifyKeyV1: ByteArray) {
        if (signature == null) throw legacy()
        val ok =
            try {
                Authenticity.verify(B64u.decode(signature), Authenticity.recoveryKeyMessage(B64u.decode(recoveryPublicKey)), verifyKeyV1)
            } catch (_: CryptoException) {
                false
            }
        if (!ok) throw unverified("the recovery key is not signed by version 1")
    }

    fun deviceKeyProof(adk: ByteArray, v: Int, deviceId: String, publicKey: ByteArray): DeviceKeyRequest = DeviceKeyRequest(
        B64u.encode(publicKey),
        v,
        B64u.encode(Authenticity.sign(adk, Authenticity.deviceKeyMessage(deviceId, v, publicKey)))
    )

    fun checkDeviceKeyProof(verifyKey: ByteArray, deviceId: String, v: Int, publicKey: String, proof: String): Boolean = try {
        Authenticity.verify(B64u.decode(proof), Authenticity.deviceKeyMessage(deviceId, v, B64u.decode(publicKey)), verifyKey)
    } catch (_: CryptoException) {
        false
    }
}

/** Key flows (§1.8), the Kotlin twins of the Web's bootstrap.ts, pairing.ts and rotation.ts. */
object KeyFlows {
    val DEFAULT_ARGON = Primitives.ArgonParams(65536, 3, 1)

    /** A setup ready to post; [commit] stores ADK v1 only after the server accepted it (§1.8 Setup). */
    class PreparedSetup(val request: KeysSetupRequest, val phrase: String, private val adk: ByteArray) {
        private var done = false

        suspend fun commit(store: KeyStore) {
            check(!done) { "setup already committed or discarded" }
            done = true
            try {
                store.save(1, adk)
            } finally {
                Primitives.zero(adk)
            }
        }

        fun discard() {
            done = true
            Primitives.zero(adk)
        }
    }

    suspend fun prepareSetup(store: KeyStore, params: Primitives.ArgonParams = DEFAULT_ARGON): PreparedSetup {
        if (store.current() != 0) throw CryptoException("invalid_input", "this device already holds an ADK")
        val phrase = Phrase.generate()
        val salt = Primitives.random(16)
        val rec = Recovery.derive(phrase, salt, params)
        val adk = Primitives.random(32)
        try {
            val anchorKey = Authenticity.anchorKey(rec.seed)
            val verifyKey = Authenticity.verifyKey(adk)
            val request =
                KeysSetupRequest(
                    recoveryPublicKey = B64u.encode(rec.publicKey),
                    salt = B64u.encode(salt),
                    params = Argon2Spec(params.m, params.t, params.p),
                    recoveryBlob = B64u.encode(Wrap.wrap(adk, Primitives.random(32), rec.publicKey, "recovery", 1)),
                    verifyKey = B64u.encode(verifyKey),
                    recoveryAnchor = B64u.encode(Authenticity.recoveryAnchor(anchorKey, verifyKey)),
                    recoveryKeySignature = B64u.encode(Authenticity.sign(adk, Authenticity.recoveryKeyMessage(rec.publicKey)))
                )
            Primitives.zero(anchorKey)
            return PreparedSetup(request, phrase, adk)
        } catch (e: Exception) {
            Primitives.zero(adk)
            throw e
        } finally {
            Primitives.zero(rec.seed, rec.privateKey)
        }
    }

    /** Recovery with the phrase, fully anchored (§1.13 Recovery). Returns the stored version. */
    suspend fun recover(store: KeyStore, phrase: String, response: RecoveryBlob, chain: ChainState, recoveryKey: RecoveryInfo?): Int {
        val v = response.keyVersion
        if (v < 1) throw CryptoException("invalid_input", "key version")
        val salt = B64u.decode(response.salt)
        val rec = Recovery.derive(phrase, salt, Primitives.ArgonParams(response.params.m, response.params.t, response.params.p))
        val anchorKey = Authenticity.anchorKey(rec.seed)
        val raw =
            try {
                Wrap.unwrap(B64u.decode(response.recoveryBlob), rec.privateKey, "recovery", v)
            } finally {
                Primitives.zero(rec.seed, rec.privateKey)
            }
        try {
            val anchor = response.recoveryAnchor ?: throw CryptoException("keys_legacy", "this account has no recovery anchor")
            try {
                val verifyKeyV1 = Verify.versionVerifyKey(chain.versions, 1)
                if (!Primitives.constantTimeEquals(Authenticity.recoveryAnchor(anchorKey, verifyKeyV1), B64u.decode(anchor))) {
                    throw CryptoException("recovery_unverified", "the recovery anchor does not match the first verify key")
                }
                if (recoveryKey == null || !Primitives.constantTimeEquals(rec.publicKey, B64u.decode(recoveryKey.publicKey))) {
                    throw CryptoException("recovery_unverified", "the account lists another recovery key than this phrase derives")
                }
                Verify.assertRecoveryKeySigned(recoveryKey.publicKey, recoveryKey.signature, verifyKeyV1)
                Verify.verifySignatureChain(chain, v)
                Verify.assertAdkMatchesVersion(raw, chain.versions, v)
                Verify.assertAnchoredOnHeld(store, chain, v, raw)
            } catch (e: CryptoException) {
                if (e.code == "keys_legacy" || e.code == "recovery_unverified") throw e
                throw CryptoException("recovery_unverified", "the recovered key does not verify against the account")
            }
            store.save(v, raw)
        } finally {
            Primitives.zero(raw, anchorKey)
        }
        return v
    }

    // --- Pairing (§1.8) ---

    const val PAIRING_PREFIX = "sa1"

    fun pairingFingerprint(ephemeralPublicKey: String): String {
        val pub = B64u.decode(ephemeralPublicKey)
        if (pub.size != 32) throw CryptoException("invalid_input", "ephemeral public key must be 32 bytes")
        return B64u.encode(Primitives.sha256(pub).copyOf(16))
    }

    fun pairingPayload(code: String, ephemeralPublicKey: String): String {
        require(code.isNotEmpty() && code.none { it.isWhitespace() }) { "pairing code is empty or has whitespace" }
        return "$PAIRING_PREFIX.$code.${pairingFingerprint(ephemeralPublicKey)}"
    }

    /** `sa1.<code>.<fingerprint>` from a scanned QR or pasted text, or null. */
    fun parsePairingPayload(text: String): Pair<String, String>? {
        val t = text.trim()
        val first = t.indexOf('.')
        val last = t.lastIndexOf('.')
        if (first < 0 || last <= first || t.substring(0, first) != PAIRING_PREFIX) return null
        val code = t.substring(first + 1, last)
        val fp = t.substring(last + 1)
        if (code.isEmpty() || code.any { it.isWhitespace() }) return null
        return try {
            if (B64u.decode(fp).size != 16) null else code to fp
        } catch (_: CryptoException) {
            null
        }
    }

    /** The existing device wraps its newest ADK to the new device's ephemeral key, after the fingerprint check. */
    suspend fun wrapForPairing(store: KeyStore, ephemeralPublicKey: String, fingerprint: String): PairingWrapRequest {
        if (!Primitives.constantTimeEquals(B64u.decode(pairingFingerprint(ephemeralPublicKey)), B64u.decode(fingerprint))) {
            throw CryptoException("untrusted_sender", "pairing key does not match the scanned code")
        }
        val v = store.current()
        if (v == 0) throw CryptoException("not_found", "this device holds no ADK to share")
        val raw = store.adk(v)
        val devicePrivate = store.devicePrivateKey()
        try {
            val blob = Wrap.wrap(raw, devicePrivate, B64u.decode(ephemeralPublicKey), "pair", v)
            return PairingWrapRequest(v, B64u.encode(Primitives.x25519PublicKey(devicePrivate)), B64u.encode(blob))
        } finally {
            Primitives.zero(raw, devicePrivate)
        }
    }

    /** The new device accepts the pairing blob (§1.13 Pairing receive). */
    suspend fun acceptPairing(
        store: KeyStore,
        ephemeralPrivate: ByteArray,
        ready: PairingStatus,
        chain: ChainState,
        trustedSenderKeys: List<String?>
    ): Int {
        val v = ready.keyVersion ?: throw CryptoException("invalid_input", "no key version")
        val senderKey = ready.senderPublicKey ?: throw CryptoException("invalid_input", "no sender key")
        val blobText = ready.blob ?: throw CryptoException("invalid_input", "no blob")
        if (senderKey !in trustedSenderKeys) throw CryptoException("untrusted_sender", "pairing sender is not a device of this account")
        val blob = B64u.decode(blobText)
        if (!Primitives.constantTimeEquals(Wrap.senderPublicKey(blob), B64u.decode(senderKey))) {
            throw CryptoException("untrusted_sender", "the blob is not wrapped by the named sender")
        }
        val raw = Wrap.unwrap(blob, ephemeralPrivate, "pair", v)
        try {
            Verify.assertAdkMatchesVersion(raw, chain.versions, v)
            if (store.current() > 0) Verify.assertAnchoredOnHeld(store, chain, v, raw) else Verify.verifySignatureChain(chain, v)
            store.save(v, raw)
        } finally {
            Primitives.zero(raw)
        }
        return v
    }

    // --- Device key, pickup, chain import, rotation ---

    /** Registration of this device's wrapping key, proven by the newest version held (§1.7). */
    suspend fun proveDeviceKey(store: KeyStore, deviceId: String): DeviceKeyRequest {
        val v = store.current()
        if (v == 0) throw CryptoException("not_found", "no ADK to prove the device key with")
        val raw = store.adk(v)
        val priv = store.devicePrivateKey()
        try {
            return Verify.deviceKeyProof(raw, v, deviceId.lowercase(), Primitives.x25519PublicKey(priv))
        } finally {
            Primitives.zero(raw, priv)
        }
    }

    data class PendingResult(val accepted: List<Int>, val failed: List<Pair<Int, String>>)

    suspend fun acceptPendingBlobs(store: KeyStore, pending: List<PendingBlob>, chain: ChainState): PendingResult {
        val accepted = mutableListOf<Int>()
        val failed = mutableListOf<Pair<Int, String>>()
        for (p in pending.sortedBy { it.keyVersion }) {
            var raw: ByteArray? = null
            var held: ByteArray? = null
            val priv = store.devicePrivateKey()
            try {
                if (p.keyVersion < 2) throw unverified("a rotation blob exists only for key_version >= 2")
                if (!store.has(p.keyVersion - 1)) throw CryptoException("not_found", "this device lacks ADK version ${p.keyVersion - 1}")
                raw = Wrap.unwrap(B64u.decode(p.blob), priv, "rotate", p.keyVersion)
                held = store.adk(p.keyVersion - 1)
                Verify.assertRotationLink(raw, held, chain, p.keyVersion)
                store.save(p.keyVersion, raw)
                accepted += p.keyVersion
            } catch (e: CryptoException) {
                failed += p.keyVersion to e.code
            } finally {
                Primitives.zero(raw, held, priv)
            }
        }
        return PendingResult(accepted, failed)
    }

    /** Walks down from the newest held ADK, verifying each older key (§1.13 Chain import). */
    suspend fun importChain(store: KeyStore, state: ChainState): List<Int> {
        val added = mutableListOf<Int>()
        var v = store.current()
        while (v >= 2) {
            if (store.has(v - 1)) {
                v--
                continue
            }
            val blob = state.chain.firstOrNull { it.keyVersion == v }?.blob ?: break
            val raw = store.adk(v)
            var previous: ByteArray? = null
            try {
                val link =
                    try {
                        B64u.decode(blob)
                    } catch (_: CryptoException) {
                        throw unverified("malformed chain link for version $v")
                    }
                previous = Wrap.unwrapChain(link, raw, v)
                if (!Primitives.constantTimeEquals(Authenticity.verifyKey(previous), Verify.versionVerifyKey(state.versions, v - 1))) {
                    throw unverified("ADK version ${v - 1} from the chain does not match the account's verify key")
                }
                val row = state.versions.firstOrNull { it.keyVersion == v }
                val sig = row?.signature ?: if (row != null) throw legacy() else throw unverified("version $v is unsigned")
                if (!Authenticity.verify(
                        B64u.decode(sig),
                        Authenticity.rotationMessage(v, Verify.versionVerifyKey(state.versions, v), link),
                        Authenticity.verifyKey(previous)
                    )
                ) {
                    throw unverified("version $v is not signed by version ${v - 1}")
                }
                store.save(v - 1, previous)
                added += v - 1
            } finally {
                Primitives.zero(raw, previous)
            }
            v--
        }
        return added
    }

    enum class Skip { NoKey, Unproven, Stale, Excluded }

    class PreparedRotation(
        val request: KeysRotateRequest,
        val skipped: List<Pair<String, Skip>>,
        private val next: ByteArray,
        private val version: Int
    ) {
        private var done = false

        suspend fun commit(store: KeyStore) {
            check(!done) { "rotation already committed or discarded" }
            done = true
            try {
                store.save(version, next)
            } finally {
                Primitives.zero(next)
            }
        }

        fun discard() {
            done = true
            Primitives.zero(next)
        }
    }

    private fun skipReason(d: DeviceKey, v: Int, verifyKey: ByteArray, exclude: Set<String>): Skip? {
        if (d.deviceId.lowercase() in exclude) return Skip.Excluded
        val pub = d.publicKey ?: return Skip.NoKey
        val kv = d.keyVersion
        val proof = d.proof
        if (proof == null || kv == null) return Skip.Unproven
        if (kv < v) return Skip.Stale
        if (kv != v) return Skip.Unproven
        return if (Verify.checkDeviceKeyProof(verifyKey, d.deviceId, v, pub, proof)) null else Skip.Unproven
    }

    /** A rotation to v+1 (§1.8 Rotation, §1.13 Rotating); refuses unless the signed recovery key verifies with the own ADK(1). */
    suspend fun prepareRotation(
        store: KeyStore,
        serverKeyVersion: Int,
        recovery: RecoveryInfo,
        devices: List<DeviceKey>,
        exclude: Collection<String> = emptyList()
    ): PreparedRotation {
        val local = store.current()
        if (local != serverKeyVersion) {
            throw CryptoException(
                if (local <
                    serverKeyVersion
                ) {
                    "not_found"
                } else {
                    "invalid_input"
                },
                "local ADK version $local differs from the server's $serverKeyVersion"
            )
        }
        if (!store.has(1)) throw unverified("this device lacks ADK version 1 to check the recovery key against")
        val adk1 = store.adk(1)
        val verifyKeyV1 =
            try {
                Authenticity.verifyKey(adk1)
            } finally {
                Primitives.zero(adk1)
            }
        Verify.assertRecoveryKeySigned(recovery.publicKey, recovery.signature, verifyKeyV1)
        val ex = exclude.map { it.lowercase() }.toSet()
        val next = Primitives.random(32)
        val previous = store.adk(local)
        try {
            val currentVerifyKey = Authenticity.verifyKey(previous)
            val chain = Wrap.wrapChain(previous, next, local + 1)
            val recoveryBlob = Wrap.wrap(next, Primitives.random(32), B64u.decode(recovery.publicKey), "recovery", local + 1)
            val skipped = mutableListOf<Pair<String, Skip>>()
            val blobs = mutableListOf<DeviceBlob>()
            for (d in devices) {
                val reason = skipReason(d, local, currentVerifyKey, ex)
                if (reason != null) {
                    skipped += d.deviceId to reason
                    continue
                }
                blobs +=
                    DeviceBlob(
                        d.deviceId,
                        B64u.encode(
                            Wrap.wrap(
                                next,
                                Primitives.random(32),
                                B64u.decode(d.publicKey!!),
                                "rotate",
                                local + 1
                            )
                        )
                    )
            }
            val verifyKey = Authenticity.verifyKey(next)
            val signature = Authenticity.sign(previous, Authenticity.rotationMessage(local + 1, verifyKey, chain))
            val req =
                KeysRotateRequest(
                    local + 1,
                    B64u.encode(recoveryBlob),
                    B64u.encode(chain),
                    blobs,
                    B64u.encode(verifyKey),
                    B64u.encode(signature)
                )
            return PreparedRotation(req, skipped, next, local + 1)
        } catch (e: Exception) {
            Primitives.zero(next)
            throw e
        } finally {
            Primitives.zero(previous)
        }
    }
}

/** A KeyStore in memory (tests, and as the in-process cache of the Keystore-backed store). */
class MemoryKeyStore : KeyStore {
    private val adks = sortedMapOf<Int, ByteArray>()
    private var device: ByteArray? = null

    override suspend fun versions(): List<Int> = adks.keys.toList()

    override suspend fun adk(v: Int): ByteArray = adks[v]?.copyOf() ?: throw CryptoException("not_found", "no ADK version $v")

    override suspend fun save(v: Int, adk: ByteArray) {
        val existing = adks[v]
        if (existing != null) {
            if (!Primitives.constantTimeEquals(
                    existing,
                    adk
                )
            ) {
                throw CryptoException("invalid_input", "different bytes for stored version $v")
            }
            return
        }
        adks[v] = adk.copyOf()
    }

    override suspend fun devicePrivateKey(): ByteArray = (device ?: Primitives.clamp(Primitives.random(32)).also { device = it }).copyOf()

    override suspend fun clear() {
        adks.values.forEach { it.fill(0) }
        adks.clear()
        device?.fill(0)
        device = null
    }
}
