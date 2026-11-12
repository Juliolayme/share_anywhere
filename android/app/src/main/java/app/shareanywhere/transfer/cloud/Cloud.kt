package app.shareanywhere.transfer.cloud

import app.shareanywhere.account.crypto.B64u
import app.shareanywhere.account.crypto.Primitives
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.CloudApi
import app.shareanywhere.data.api.CloudObject
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.data.ws.SocketEvent
import app.shareanywhere.transfer.engine.FileSource
import app.shareanywhere.transfer.engine.StreamHasher
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Cloud Distribution (docs/TRANSFER_PROTOCOL.md §9, docs/API.md §2.6): the per-file crypto shared byte for byte with
 * the Web and iOS through `shared/protocol/schemas/cloud-vectors.json`, the sender's uploader and key responder, and
 * the receiver's key request and download.
 */
object CloudCrypto {
    const val PART_OVERHEAD = 28
    const val FILE_KEY_BYTES = 32

    private fun partAad(objectId: String, n: Int, count: Int) = "sa-cloud-v1|$objectId|$n|$count".toByteArray()

    private fun wrapAad(objectId: String, fileId: String) = "sa-cloud-wrap-v1|$objectId|$fileId".toByteArray()

    fun newFileKey(): ByteArray = Primitives.random(FILE_KEY_BYTES)

    /** Stored part: nonce || ciphertext || tag. */
    fun sealPart(
        key: ByteArray,
        objectId: String,
        n: Int,
        count: Int,
        plaintext: ByteArray,
        nonce: ByteArray = Primitives.random(Primitives.NONCE_BYTES)
    ): ByteArray = nonce + Primitives.aesGcmSeal(key, nonce, plaintext, partAad(objectId, n, count))

    /** Opens a stored part; throws when it was altered, moved or truncated. */
    fun openPart(key: ByteArray, objectId: String, n: Int, count: Int, stored: ByteArray): ByteArray {
        if (stored.size < PART_OVERHEAD) throw CloudException(CloudFailure.INTEGRITY)
        return try {
            Primitives.aesGcmOpen(key, stored.copyOfRange(0, 12), stored.copyOfRange(12, stored.size), partAad(objectId, n, count))
        } catch (_: Exception) {
            throw CloudException(CloudFailure.INTEGRITY)
        }
    }

    private fun wrapKey(
        mine: ByteArray,
        peer: ByteArray,
        senderPublic: ByteArray,
        receiverPublic: ByteArray,
        sessionId: String,
        receiverPid: String
    ): ByteArray {
        val shared = Primitives.x25519(mine, peer)
        return try {
            Primitives.hkdf(shared, senderPublic + receiverPublic, "sa-cloud-key-v1|$sessionId|$receiverPid".toByteArray())
        } finally {
            Primitives.zero(shared)
        }
    }

    /** The sender's CLOUD_KEY answer to a receiver's CLOUD_KEY_REQUEST. */
    fun wrapKeys(
        keys: List<CloudObjectKey>,
        receiverPublic: String,
        sessionId: String,
        receiverPid: String,
        senderPrivate: ByteArray = Primitives.random(32),
        nonces: List<ByteArray>? = null
    ): CloudKeyPayload {
        val rpub = B64u.decode(receiverPublic)
        val spub = Primitives.x25519PublicKey(senderPrivate)
        val k = wrapKey(senderPrivate, rpub, spub, rpub, sessionId, receiverPid)
        val out =
            keys.mapIndexed { i, o ->
                val nonce = nonces?.get(i) ?: Primitives.random(Primitives.NONCE_BYTES)
                val sealed = Primitives.aesGcmSeal(k, nonce, o.key + o.sha256, wrapAad(o.objectId, o.fileId))
                CloudWrappedKey(o.objectId, o.fileId, B64u.encode(nonce), B64u.encode(sealed))
            }
        Primitives.zero(k)
        return CloudKeyPayload(B64u.encode(spub), out)
    }

    /** The receiver unwraps a CLOUD_KEY answer with its ephemeral key; entries that fail authentication are skipped. */
    fun unwrapKeys(payload: CloudKeyPayload, receiverPrivate: ByteArray, sessionId: String, receiverPid: String): List<CloudObjectKey> {
        val spub = runCatching { B64u.decode(payload.publicKey) }.getOrNull() ?: return emptyList()
        val rpub = Primitives.x25519PublicKey(receiverPrivate)
        val k = runCatching { wrapKey(receiverPrivate, spub, spub, rpub, sessionId, receiverPid) }.getOrNull() ?: return emptyList()
        val out =
            payload.keys.mapNotNull { w ->
                runCatching {
                    val plain = Primitives.aesGcmOpen(k, B64u.decode(w.nonce), B64u.decode(w.wrapped), wrapAad(w.objectId, w.fileId))
                    if (plain.size != 64) {
                        null
                    } else {
                        CloudObjectKey(w.objectId, w.fileId, plain.copyOfRange(0, 32), plain.copyOfRange(32, 64))
                    }
                }.getOrNull()
            }
        Primitives.zero(k)
        return out
    }
}

enum class CloudFailure { INTEGRITY, PAUSED, UNAVAILABLE, NETWORK }

class CloudException(val failure: CloudFailure) : Exception(failure.name)

class CloudObjectKey(val objectId: String, val fileId: String, val key: ByteArray, val sha256: ByteArray)

@Serializable
data class CloudWrappedKey(
    @SerialName("object_id") val objectId: String,
    @SerialName("file_id") val fileId: String,
    val nonce: String,
    val wrapped: String
)

@Serializable
data class CloudKeyPayload(@SerialName("public_key") val publicKey: String, val keys: List<CloudWrappedKey>)

@Serializable
data class CloudKeyRequest(@SerialName("public_key") val publicKey: String)

enum class CloudUploadStatus { WAITING, UPLOADING, READY, PAUSED, FAILED }

data class CloudUploadFile(val fileId: String, val name: String, val size: Long, val uploaded: Long, val status: CloudUploadStatus)

data class CloudUploadState(val files: List<CloudUploadFile> = emptyList(), val error: String? = null) {
    val ready: Boolean get() = files.isNotEmpty() && files.all { it.status == CloudUploadStatus.READY }
    val paused: Boolean get() = files.any { it.status == CloudUploadStatus.PAUSED }
}

/** Catalog keys (R.string names without the prefix) for cloud errors. */
private val ERROR_KEYS =
    mapOf(
        "cloud_budget_exhausted" to "product_cloud_budget_exhausted",
        "cloud_consent_required" to "product_cloud_consent_needed",
        "cloud_requires_account" to "product_cloud_signin",
        "cloud_unavailable" to "product_cloud_unavailable"
    )

private fun signal(type: String, sessionId: String, to: String, payload: JsonObject) = buildJsonObject {
    put("type", type)
    put("session_id", sessionId)
    put("to", to)
    put("payload", payload)
}

/**
 * The sender side (docs/TRANSFER_PROTOCOL.md §9), the Android twin of the Web's `CloudUploader`: distributes each
 * file, encrypts it part by part under a fresh key, uploads and seals, and answers receivers' CLOUD_KEY_REQUEST with
 * the keys wrapped to their ephemeral X25519 keys. Keys stay in memory.
 */
class CloudUploader(
    private val scope: CoroutineScope,
    private val sessionId: String,
    private val api: CloudApi,
    private val socket: SessionSocket,
    private val json: Json,
    private val files: List<File>
) {
    class File(val fileId: String, val name: String, val size: Long, val source: FileSource)

    private val _state =
        MutableStateFlow(CloudUploadState(files.map { CloudUploadFile(it.fileId, it.name, it.size, 0, CloudUploadStatus.WAITING) }))
    val state: StateFlow<CloudUploadState> = _state.asStateFlow()
    private val keys = HashMap<String, CloudObjectKey>()
    private val lock = Mutex()
    private var socketJob: Job? = null
    private var job: Job? = null
    private val resumed = MutableStateFlow(0)

    fun start() {
        socketJob = scope.launch { socket.subscribe().collect { onSocket(it) } }
        job =
            scope.launch {
                for (f in files) {
                    try {
                        upload(f)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        val code = (e as? ApiException)?.code ?: "network"
                        patch(f.fileId) { it.copy(status = CloudUploadStatus.FAILED) }
                        _state.update { it.copy(error = ERROR_KEYS[code] ?: "product_cloud_upload_failed") }
                        return@launch
                    }
                }
            }
    }

    fun dispose() {
        job?.cancel()
        socketJob?.cancel()
    }

    private fun patch(fileId: String, f: (CloudUploadFile) -> CloudUploadFile) =
        _state.update { s -> s.copy(files = s.files.map { if (it.fileId == fileId) f(it) else it }) }

    private suspend fun upload(f: File) {
        var o = api.distribute(f.fileId)
        if (o.status != "UPLOADING") {
            // An object from an earlier run whose key this process no longer holds: receivers keep P2P for this file.
            patch(f.fileId) { it.copy(status = CloudUploadStatus.FAILED) }
            return
        }
        patch(f.fileId) { it.copy(status = CloudUploadStatus.UPLOADING) }
        val key = CloudCrypto.newFileKey()
        val hasher = StreamHasher()
        for (n in 0 until o.partCount) {
            val off = n.toLong() * o.partSize
            val len = maxOf(0L, minOf(o.partSize.toLong(), f.size - off)).toInt()
            val plain = if (len > 0) f.source.read(off, len) else ByteArray(0)
            hasher.update(off, plain)
            val stored = CloudCrypto.sealPart(key, o.id, n, o.partCount, plain)
            o = put(f.fileId, o.id, n, stored)
            patch(f.fileId) { it.copy(uploaded = off + len, status = CloudUploadStatus.UPLOADING) }
        }
        o = api.seal(o.id)
        lock.withLock { keys[o.id] = CloudObjectKey(o.id, f.fileId, key, hexBytes(hasher.hex())) }
        patch(f.fileId) { it.copy(status = CloudUploadStatus.READY, uploaded = f.size) }
    }

    /** One part: retries network errors with backoff; waits out a used-up budget until CLOUD_UPDATED lifts it. */
    private suspend fun put(fileId: String, objectId: String, n: Int, stored: ByteArray): CloudObject {
        var attempt = 0
        while (true) {
            try {
                val o = api.putPart(objectId, n, stored)
                if (_state.value.error != null) _state.update { it.copy(error = null) }
                return o
            } catch (e: ApiException) {
                if (e.code == "cloud_budget_exhausted") {
                    patch(fileId) { it.copy(status = CloudUploadStatus.PAUSED) }
                    _state.update { it.copy(error = ERROR_KEYS[e.code]) }
                    val seen = resumed.value
                    withTimeoutOrNull(60_000) { resumed.first { it != seen } }
                    continue
                }
                if (e.status < 500 && e.status != 429) throw e
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                // network: retry below
            }
            delay(minOf(15_000L, 1000L shl minOf(attempt, 4)))
            attempt++
        }
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, e: kotlinx.serialization.json.JsonElement): T? =
        runCatching { json.decodeFromJsonElement(serializer, e) }.getOrNull()

    private suspend fun onSocket(e: SocketEvent) {
        if (e.type == SocketEvent.OPEN) {
            // A request sent while the socket was down was dropped: ask again now, without waiting out the 10 s.
            lastAsk = Long.MIN_VALUE / 2
            return refresh()
        }
        if (e.sessionId != sessionId) return
        when (e.type) {
            "CLOUD_UPDATED" -> {
                val o = e.body["object"]?.let { decode(CloudObject.serializer(), it) }
                if (o != null && !o.paused) resumed.update { it + 1 }
            }
            "CLOUD_KEY_REQUEST" -> {
                // The server relays this only from a JOINED receiver of this session (docs/API.md §4).
                val from = e.body["from"]?.jsonPrimitive?.content ?: return
                val req = e.body["payload"]?.let { decode(CloudKeyRequest.serializer(), it) } ?: return
                val ks = lock.withLock { keys.values.sortedBy { it.objectId } }
                if (ks.isEmpty()) return
                val payload = runCatching { CloudCrypto.wrapKeys(ks, req.publicKey, sessionId, from) }.getOrNull() ?: return
                val body = json.encodeToJsonElement(CloudKeyPayload.serializer(), payload).jsonObject
                socket.send(signal("CLOUD_KEY", sessionId, from, body))
            }
        }
    }
}

/** The receiver side (docs/TRANSFER_PROTOCOL.md §9), the Android twin of the Web's `CloudReceive`. */
class CloudReceive(
    private val scope: CoroutineScope,
    private val sessionId: String,
    private val participantId: String,
    private val senderPid: String,
    private val api: CloudApi,
    private val socket: SessionSocket,
    private val json: Json,
    private val clock: () -> Long,
    private val onChange: () -> Unit
) {
    private val objects = HashMap<String, CloudObject>() // by file id
    private val keys = HashMap<String, CloudObjectKey>() // by object id
    private val lock = Mutex()
    private var eph: ByteArray? = null
    private var lastAsk = Long.MIN_VALUE / 2

    /** Per file: the next part to fetch and the hash of the parts before it, so a retry resumes (§9). */
    private class Cursor(var next: Int, val hasher: StreamHasher)

    private val cursors = HashMap<String, Cursor>()

    /** Whether a download of this file stopped part-way and can resume (its parts so far are in the document). */
    suspend fun resumable(fileId: String): Boolean = lock.withLock { (cursors[fileId]?.next ?: 0) > 0 }

    /** Forgets a stopped download's cursor: the caller starts a new partial file, so the next download starts at part 0. */
    suspend fun restart(fileId: String) {
        lock.withLock { cursors.remove(fileId) }
    }
    private var socketJob: Job? = null

    fun start() {
        socketJob = scope.launch { socket.subscribe().collect { onSocket(it) } }
        scope.launch { refresh() }
    }

    /** Loads the session's objects and asks for missing keys (at start and after every socket (re)connect). */
    private suspend fun refresh() {
        val list = runCatching { api.list(sessionId) }.getOrNull()
        if (list != null) lock.withLock { list.forEach { objects[it.fileId] = it } }
        askForKeys()
        onChange()
    }

    fun dispose() {
        socketJob?.cancel()
    }

    /** A READY, unpaused object whose key this receiver holds. */
    suspend fun ready(fileId: String): Boolean = lock.withLock {
        val o = objects[fileId] ?: return@withLock false
        o.status == "READY" && !o.paused && keys.containsKey(o.id)
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, e: kotlinx.serialization.json.JsonElement): T? =
        runCatching { json.decodeFromJsonElement(serializer, e) }.getOrNull()

    private suspend fun onSocket(e: SocketEvent) {
        if (e.type == SocketEvent.OPEN) {
            // A request sent while the socket was down was dropped: ask again now, without waiting out the 10 s.
            lastAsk = Long.MIN_VALUE / 2
            return refresh()
        }
        if (e.sessionId != sessionId) return
        when (e.type) {
            "CLOUD_UPDATED" -> {
                val o = e.body["object"]?.let { decode(CloudObject.serializer(), it) } ?: return
                lock.withLock { if (o.status == "DELETED") objects.remove(o.fileId) else objects[o.fileId] = o }
                askForKeys()
                onChange()
            }
            "CLOUD_KEY" -> {
                if (e.body["from"]?.jsonPrimitive?.content != senderPid) return
                val priv = eph ?: return
                val payload = e.body["payload"]?.let { decode(CloudKeyPayload.serializer(), it) } ?: return
                val ks = CloudCrypto.unwrapKeys(payload, priv, sessionId, participantId)
                lock.withLock { ks.forEach { keys[it.objectId] = it } }
                onChange()
            }
        }
    }

    /** Asks the sender for keys when a READY object lacks one (at most once every 10 s). */
    suspend fun askForKeys() {
        val missing = lock.withLock { objects.values.any { it.status == "READY" && !keys.containsKey(it.id) } }
        if (!missing || clock() - lastAsk < 10_000) return
        val priv = eph ?: Primitives.random(32).also { eph = it }
        val request = CloudKeyRequest(B64u.encode(Primitives.x25519PublicKey(priv)))
        val payload = json.encodeToJsonElement(CloudKeyRequest.serializer(), request)
        // Only a request that went out starts the 10 s wait; SOCKET_OPEN retries one that could not be sent.
        if (socket.send(signal("CLOUD_KEY_REQUEST", sessionId, senderPid, payload.jsonObject))) lastAsk = clock()
    }

    /**
     * Downloads and decrypts one file in order, writing each part at its offset, then checks the whole-file SHA-256
     * and tells the server this receiver has it.
     */
    suspend fun download(
        fileId: String,
        write: suspend (Long, ByteArray) -> Unit,
        progress: suspend (Long) -> Unit,
        stopped: () -> Boolean
    ) {
        val (o, k) =
            lock.withLock {
                val o = objects[fileId] ?: throw CloudException(CloudFailure.UNAVAILABLE)
                o to (keys[o.id] ?: throw CloudException(CloudFailure.UNAVAILABLE))
            }
        val cursor = lock.withLock { cursors.getOrPut(fileId) { Cursor(0, StreamHasher()) } }
        val hasher = cursor.hasher
        for (n in cursor.next until o.partCount) {
            if (stopped()) throw CloudException(CloudFailure.NETWORK)
            val stored =
                try {
                    api.getPart(o.id, n)
                } catch (e: ApiException) {
                    throw CloudException(
                        when {
                            e.code == "cloud_budget_exhausted" -> CloudFailure.PAUSED
                            e.status == 404 || e.status == 409 -> CloudFailure.UNAVAILABLE
                            else -> CloudFailure.NETWORK
                        }
                    )
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    throw CloudException(CloudFailure.NETWORK)
                }
            val plain =
                try {
                    CloudCrypto.openPart(k.key, o.id, n, o.partCount, stored)
                } catch (e: CloudException) {
                    lock.withLock { cursors.remove(fileId) }
                    throw e
                }
            val off = n.toLong() * o.partSize
            write(off, plain)
            hasher.update(off, plain)
            cursor.next = n + 1
            progress(off + plain.size)
        }
        lock.withLock { cursors.remove(fileId) }
        if (!MessageDigest.isEqual(hexBytes(hasher.hex()), k.sha256)) throw CloudException(CloudFailure.INTEGRITY)
        runCatching { api.received(o.id) }
    }
}

internal fun hexBytes(s: String): ByteArray = ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
