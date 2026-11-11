package app.shareanywhere.account.keys

import android.content.Context
import android.util.AtomicFile
import app.shareanywhere.account.crypto.B64u
import app.shareanywhere.account.crypto.CryptoException
import app.shareanywhere.account.crypto.KeyFlows
import app.shareanywhere.account.crypto.KeyStore
import app.shareanywhere.account.crypto.Primitives
import app.shareanywhere.account.crypto.Verify
import app.shareanywhere.data.api.AccountApi
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.KeyChain
import app.shareanywhere.data.api.KeysState
import app.shareanywhere.data.api.PairingPeer
import app.shareanywhere.data.api.PairingStatus
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/** Account Data Key state of this device (PRD §7.5), as the Web's KeyStatus. */
enum class KeyStatus { None, Checking, Setup, Pair, Ready, Error, Rejected, Refused, Legacy }

data class KeyCheck(
    val status: KeyStatus,
    val keyVersion: Int,
    val state: KeysState?,
    val newVersions: List<Int>,
    val rotationOwed: Boolean
)

class KeyStateException(val status: KeyStatus) : Exception("key state: $status")

/** Key state from the server's newest version and the newest version held here. */
fun deriveKeyStatus(server: Int, local: Int): KeyStatus = if (server <=
    0
) {
    KeyStatus.Setup
} else if (local >= server) {
    KeyStatus.Ready
} else {
    KeyStatus.Pair
}

@Serializable
private data class Meta(val owner: String? = null, val excluded: List<String> = emptyList())

/** Devices this device revoked (`<id>@<version>`, §1.8 Remembered exclusions) and the account they belong to. */
class SyncMeta(context: Context, private val json: Json = Json { ignoreUnknownKeys = true }) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "account_meta.json"))
    private val lock = Mutex()

    private suspend fun read(): Meta = withContext(Dispatchers.IO) {
        runCatching { json.decodeFromString(Meta.serializer(), String(file.readFully())) }.getOrDefault(Meta())
    }

    private suspend fun write(m: Meta) = withContext(Dispatchers.IO) {
        val out = file.startWrite()
        try {
            out.write(json.encodeToString(Meta.serializer(), m).toByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    suspend fun owner(): String? = lock.withLock { read().owner }

    suspend fun setOwner(id: String) = lock.withLock { write(read().copy(owner = id)) }

    suspend fun excluded(): List<Pair<String, Int>> = lock.withLock {
        read().excluded.map { raw ->
            val at = raw.lastIndexOf('@')
            val v = if (at > 0) raw.substring(at + 1).toIntOrNull() else null
            if (at > 0 && v != null) raw.substring(0, at).lowercase() to v else raw.lowercase() to 0
        }
    }

    suspend fun setExcluded(list: List<Pair<String, Int>>) = lock.withLock {
        val byId = LinkedHashMap<String, Int>()
        for ((id, v) in list) byId[id] = maxOf(byId[id] ?: 0, v)
        write(read().copy(excluded = byId.map { (id, v) -> "$id@$v" }))
    }

    suspend fun wipe() = lock.withLock { withContext(Dispatchers.IO) { file.delete() } }
}

/**
 * The key steps of an added device (docs/CLIPBOARD_PROTOCOL.md §1.8), the Kotlin twin of the Web's keyFlow.ts: key
 * check (pickup, re-proof, chain import, owed rotation), rotation after a revoke with remembered exclusions, pairing
 * both ways, recovery and setup. Calls run one at a time.
 */
class AccountKeys(private val api: AccountApi, private val keys: AccountKeyStore, private val meta: SyncMeta) {
    private val queue = Mutex()

    private fun apiCode(e: Throwable, vararg codes: String) = e is ApiException && e.code in codes

    fun store(accountId: String): KeyStore = keys.forAccount(accountId)

    suspend fun check(accountId: String, deviceId: String): KeyCheck = queue.withLock { checkAndRotate(accountId, deviceId) }

    private suspend fun checkAndRotate(accountId: String, deviceId: String): KeyCheck {
        val check = checkNow(accountId, deviceId)
        if (check.status != KeyStatus.Ready || check.state?.rotationDue != true) return check
        try {
            rotateNow(accountId, deviceId, emptyList(), owed = true)
        } catch (e: Exception) {
            if (!(e is KeyStateException && e.status == KeyStatus.Pair)) {
                val status = rotationErrorStatus(e)
                return if (status != null) check.copy(status = status, rotationOwed = false) else check.copy(rotationOwed = true)
            }
        }
        val after = checkNow(accountId, deviceId)
        return after.copy(newVersions = check.newVersions + after.newVersions)
    }

    fun rotationErrorStatus(e: Throwable): KeyStatus? = when {
        e is KeyStateException -> if (e.status == KeyStatus.Pair) null else e.status
        apiCode(e, "rotation_unauthorized", "device_key_unproven", "key_version_conflict") -> KeyStatus.Refused
        apiCode(e, "keys_legacy") || (e is CryptoException && e.code == "keys_legacy") -> KeyStatus.Legacy
        e is CryptoException && e.code == "unverified" -> KeyStatus.Rejected
        else -> null
    }

    private suspend fun importOlder(store: KeyStore, chain: KeyChain? = null): List<Int> {
        val local = store.current()
        if (local < 2 || store.versions().size >= local) return emptyList()
        return KeyFlows.importChain(store, chain ?: api.chain())
    }

    private suspend fun checkNow(accountId: String, deviceId: String): KeyCheck {
        // Keys left behind by another account are never reused.
        val owner = meta.owner()
        if (owner != null && owner != accountId) {
            keys.clear()
            meta.wipe()
        }
        val store = keys.forAccount(accountId)
        val priv = store.devicePrivateKey()
        val pub = B64u.encode(Primitives.x25519PublicKey(priv))
        Primitives.zero(priv)
        var state = api.keys()
        meta.setOwner(accountId)
        val held = store.current()
        if (held > 0 && state.keyVersion < held) return KeyCheck(KeyStatus.Rejected, state.keyVersion, state, emptyList(), false)
        val newVersions = mutableListOf<Int>()
        var rejected = false
        var legacy = false
        var refused = false
        var chain: KeyChain? = null
        for (attempt in 0 until 2) {
            if (state.pending.isNotEmpty()) {
                val c = api.chain().also { chain = it }
                val res = KeyFlows.acceptPendingBlobs(store, state.pending, c)
                for (v in res.accepted) runCatching { api.ackPending(v) }
                newVersions += res.accepted
                if (res.failed.any { it.second == "unverified" }) rejected = true
                if (res.failed.any { it.second == "keys_legacy" }) legacy = true
            }
            val newest = store.current()
            val mine = state.devices.firstOrNull { it.deviceId.equals(deviceId, ignoreCase = true) }
            val stale = mine?.publicKey != pub || mine.proof == null || (mine.keyVersion ?: 0) < newest
            if (newest == 0 || !stale) break
            val registration = KeyFlows.proveDeviceKey(store, deviceId)
            try {
                api.registerKey(registration)
                state = api.keys()
                break
            } catch (e: ApiException) {
                if (e.code == "key_version_conflict" && attempt == 0) {
                    state = api.keys()
                    continue
                }
                when (e.code) {
                    "keys_legacy" -> legacy = true
                    "key_version_conflict" -> {
                        state = api.keys()
                        if (state.keyVersion <= store.current()) refused = true
                    }
                    "device_key_unproven" -> refused = true
                    else -> throw e
                }
                break
            }
        }
        var status = deriveKeyStatus(state.keyVersion, store.current())
        when {
            legacy -> status = KeyStatus.Legacy
            rejected -> status = KeyStatus.Rejected
            refused -> status = KeyStatus.Refused
            status == KeyStatus.Ready -> newVersions += importOlder(store, chain)
        }
        return KeyCheck(status, state.keyVersion, state, newVersions, false)
    }

    /** Before `DELETE /v1/devices/{id}`: remember the device at the account's current version (fail closed, QA round 8). */
    suspend fun rememberRevoked(accountId: String, ids: List<String>) {
        if (ids.isEmpty()) return
        val local = runCatching { keys.forAccount(accountId).current() }.getOrDefault(0)
        val v = maxOf(local, api.keys().keyVersion)
        meta.setExcluded(meta.excluded() + ids.map { it.lowercase() to v })
    }

    suspend fun forgetRevoked(ids: List<String>) {
        val drop = ids.map { it.lowercase() }.toSet()
        meta.setExcluded(meta.excluded().filter { it.first !in drop })
    }

    private suspend fun pruneRemembered(store: KeyStore, state: KeysState) {
        val list = meta.excluded()
        if (list.isEmpty()) return
        val keep =
            list.filter { (id, v) ->
                val d = state.devices.firstOrNull { it.deviceId.lowercase() == id }
                if (d?.publicKey == null) return@filter state.keyVersion <= v
                val kv = d.keyVersion
                if (kv != null && kv > v && d.proof != null && store.has(kv)) {
                    val raw = store.adk(kv)
                    try {
                        if (Verify.checkDeviceKeyProof(
                                app.shareanywhere.account.crypto.Authenticity.verifyKey(raw),
                                d.deviceId,
                                kv,
                                d.publicKey,
                                d.proof
                            )
                        ) {
                            return@filter false
                        }
                    } finally {
                        Primitives.zero(raw)
                    }
                }
                true
            }
        if (keep.size != list.size) meta.setExcluded(keep)
    }

    /** Rotation after revoking [exclude] (or one that is owed): returns true when a rotation was made. */
    suspend fun rotate(accountId: String, deviceId: String, exclude: List<String>): Boolean = queue.withLock {
        runCatching { rememberRevoked(accountId, exclude) }
        rotateNow(accountId, deviceId, exclude, owed = false)
    }

    private suspend fun rotateNow(accountId: String, deviceId: String, exclude: List<String>, owed: Boolean): Boolean {
        val store = keys.forAccount(accountId)
        checkNow(accountId, deviceId).let {
            if (it.status == KeyStatus.Ready &&
                it.state != null
            ) {
                runCatching { pruneRemembered(store, it.state) }
            }
        }
        val excluded = (exclude.map { it.lowercase() } + meta.excluded().map { it.first }).distinct()
        var conflictedFrom: Int? = null
        var attempt = 0
        while (true) {
            val check = checkNow(accountId, deviceId)
            val state = check.state ?: throw KeyStateException(KeyStatus.Error)
            if (state.keyVersion == 0 || (owed && !state.rotationDue)) return false
            val recovery = state.recovery ?: throw KeyStateException(KeyStatus.Rejected)
            val from = conflictedFrom
            if (from != null && state.keyVersion > from && !state.rotationDue) return true
            if (check.status in setOf(KeyStatus.Rejected, KeyStatus.Refused, KeyStatus.Legacy)) throw KeyStateException(check.status)
            if (check.status != KeyStatus.Ready) throw KeyStateException(KeyStatus.Pair)
            val prep = KeyFlows.prepareRotation(store, state.keyVersion, recovery, state.devices, excluded)
            try {
                api.rotate(prep.request)
            } catch (e: ApiException) {
                prep.discard()
                if (attempt == 0 && (e.code == "devices_changed" || e.code == "key_version_conflict")) {
                    if (e.code == "key_version_conflict") conflictedFrom = state.keyVersion
                    if (e.code == "devices_changed") completeRevokes(excluded, e, exclude)
                    attempt++
                    continue
                }
                throw e
            }
            prep.commit(store)
            runCatching { api.ackPending(prep.request.keyVersion) }
            runCatching { forgetRevoked(excluded) }
            return true
        }
    }

    /** A remembered revoke the server did not apply: send it again and keep the device excluded (never re-included). */
    private suspend fun completeRevokes(excluded: List<String>, e: ApiException, explicit: List<String>) {
        val missing = e.body?.get("missing")?.jsonArray?.mapNotNull {
            runCatching { it.jsonPrimitive.content.lowercase() }.getOrNull()
        }.orEmpty()
        val keep = explicit.map { it.lowercase() }.toSet()
        val candidates = missing.filter { it in excluded && it !in keep }
        if (candidates.isEmpty()) return
        val present = api.devices().devices.map { it.id.lowercase() }.toSet()
        for (id in candidates.filter { it in present }) {
            try {
                api.revokeDevice(id)
            } catch (x: ApiException) {
                if (x.status != 404) throw x
            }
        }
    }

    // --- Setup, pairing, recovery ---

    suspend fun prepareSetup(accountId: String): KeyFlows.PreparedSetup = KeyFlows.prepareSetup(keys.forAccount(accountId))

    class PairingStart(val ephemeralPrivate: ByteArray, val pairingId: String, val payload: String, val expiresAt: String)

    /** AC-6 on this (new) device: an ephemeral key, a pairing code and the QR payload `sa1.<code>.<fingerprint>`. */
    suspend fun startPairing(): PairingStart {
        val priv = Primitives.clamp(Primitives.random(32))
        val pub = B64u.encode(Primitives.x25519PublicKey(priv))
        val p = api.createPairing(pub)
        return PairingStart(priv, p.pairingId, KeyFlows.pairingPayload(p.code, pub), p.expiresAt)
    }

    suspend fun finishPairing(accountId: String, start: PairingStart, ready: PairingStatus): Int = queue.withLock {
        val store = keys.forAccount(accountId)
        val state = api.keys()
        val chain = api.chain()
        val v = KeyFlows.acceptPairing(store, start.ephemeralPrivate, ready, chain, state.devices.map { it.publicKey })
        Primitives.zero(start.ephemeralPrivate)
        importOlder(store, chain)
        v
    }

    suspend fun recover(accountId: String, phrase: String): Int = queue.withLock {
        val store = keys.forAccount(accountId)
        val rec = api.recovery()
        val chain = api.chain()
        val state = api.keys()
        val v = withContext(Dispatchers.Default) { KeyFlows.recover(store, phrase, rec, chain, state.recovery) }
        importOlder(store, chain)
        v
    }

    data class CodeLookup(val code: String, val fingerprint: String, val peer: PairingPeer)

    /** The existing device reads a scanned or pasted pairing payload; null when it is not one. */
    suspend fun lookupCode(text: String): CodeLookup? {
        val (code, fp) = KeyFlows.parsePairingPayload(text) ?: return null
        return CodeLookup(code, fp, api.lookupPairing(code))
    }

    /** Sends this device's newest ADK to the device that showed the code (after the fingerprint check). */
    suspend fun sendKeyTo(accountId: String, deviceId: String, found: CodeLookup) {
        var attempt = 0
        while (true) {
            val req = KeyFlows.wrapForPairing(keys.forAccount(accountId), found.peer.ephemeralPublicKey, found.fingerprint)
            try {
                api.wrapPairing(found.code, req)
                return
            } catch (e: ApiException) {
                if (attempt == 0 && (e.code == "key_version_conflict" || e.code == "device_key_unproven")) {
                    check(accountId, deviceId)
                    attempt++
                    continue
                }
                throw e
            }
        }
    }

    /** Everything this device keeps for the account (sign-out, another account, the session ended). */
    suspend fun wipe() {
        runCatching { keys.clear() }
        runCatching { meta.wipe() }
    }
}
