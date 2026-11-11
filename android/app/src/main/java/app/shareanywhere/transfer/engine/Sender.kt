package app.shareanywhere.transfer.engine

import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A file the sender reads in slices; never loaded whole. */
interface FileSource {
    val size: Long

    /** Exactly [length] bytes at [offset]; throws [IOException] when the file cannot be read or changed. */
    suspend fun read(offset: Long, length: Int): ByteArray
}

class SenderFile(
    val index: Int,
    val fileId: String,
    val transferId: String,
    val name: String,
    val size: Long,
    val mime: String,
    val source: FileSource
)

/** The file changed (shorter read) while it was being sent. */
class FileChangedException(message: String) : IOException(message)

/**
 * Whole-file SHA-256 shared by every connection to every receiver: fed in order while blocks are read for sending,
 * completed by one sequential pass when blocks went out of order. Confined to the sender's dispatcher.
 */
class FileHash(private val source: FileSource, private val scope: CoroutineScope) {
    private val h = StreamHasher()
    private var result: Deferred<String>? = null

    fun feed(offset: Long, data: ByteArray) {
        if (result == null) h.update(offset, data)
    }

    suspend fun value(): String {
        val r =
            result ?: scope.async(start = CoroutineStart.LAZY) {
                while (h.position < source.size) {
                    val off = h.position
                    h.update(off, source.read(off, minOf(Wire.BLOCK_SIZE.toLong(), source.size - off).toInt()))
                }
                h.hex()
            }.also { result = it }
        return r.await()
    }
}

class SenderCounters {
    var blocksSent = 0
    var verifiedResent = 0
    var nacks = 0
    var bytesSent = 0L
}

interface SenderEvents {
    fun onAuthorized(participantId: String) {}

    fun onProgress(file: Int, verifiedBytes: Long) {}

    fun onFileDone(file: Int) {}

    fun onComplete() {}

    fun onPaused(byPeer: Boolean) {}

    fun onResumed(byPeer: Boolean) {}

    fun onError(code: String, fatal: Boolean, message: String?) {}
}

class SenderOptions(
    val channel: TransferChannel,
    val scope: CoroutineScope,
    val sessionId: String,
    val files: List<SenderFile>,
    val hashes: Map<Int, FileHash>,
    val authorize: suspend (participantId: String, capability: String) -> Boolean,
    val events: SenderEvents = object : SenderEvents {},
    val cache: BlockCache? = null,
    val window: Int = 4,
    val highWater: Long = 8L * 1024 * 1024,
    val lowWater: Long = 1024L * 1024,
    val maxRetries: Int = 3,
    /** The sender no longer has the files: authorize, then end with file_unreadable. */
    val unavailable: Boolean = false,
    val blockSize: Int = Wire.BLOCK_SIZE,
    /** Test hook: corrupt this many upcoming blocks after hashing them. */
    var corruptBlocks: Int = 0
)

/**
 * One sender ↔ receiver connection (docs/TRANSFER_PROTOCOL.md §3–§5), the Kotlin twin of the Web's SenderConnection.
 * Create a new one per (re)connect. Every method and channel callback runs on [SenderOptions.scope]'s confined
 * dispatcher, so state is never touched by two threads.
 */
class SenderConnection(private val o: SenderOptions) {
    val counters = SenderCounters()
    var participantId: String? = null
        private set
    private val bitmaps = HashMap<Int, Bitmap>()
    private val queue = ArrayDeque<Pair<Int, Int>>()
    private val inflight = HashSet<Pair<Int, Int>>()
    private val retries = HashMap<Pair<Int, Int>, Int>()
    private val doneSent = HashSet<Int>()
    private val confirmed = HashSet<Int>()
    var isPaused = false
        private set
    private var pumping = false
    private var closed = false
    private val frameData = Wire.dataPerFrame(o.channel.maxMessageSize)
    private val drain = Drain()

    init {
        o.channel.setListener(
            object : TransferChannel.Listener {
                override fun onMessage(data: ByteArray) {
                    o.scope.launch(start = CoroutineStart.UNDISPATCHED) { onFrame(data) }
                }

                override fun onBufferedAmountChange() = drain.signal()

                override fun onClose() {
                    drain.signal()
                    end(ErrorCodes.CLOSED, false, null)
                }
            }
        )
    }

    fun verifiedBytes(file: Int): Long {
        val bm = bitmaps[file] ?: return 0
        val f = o.files.firstOrNull { it.index == file } ?: return 0
        var n = 0L
        for (i in 0 until bm.size) if (bm.has(i)) n += Wire.blockLength(f.size, i, o.blockSize)
        return n
    }

    fun pause() {
        if (isPaused || closed) return
        isPaused = true
        send(Frame.encode(FrameType.PAUSE))
        o.events.onPaused(false)
    }

    fun resume() {
        if (!isPaused || closed) return
        isPaused = false
        send(Frame.encode(FrameType.RESUME))
        o.events.onResumed(false)
        startPump()
    }

    fun cancel() = fail(ErrorCodes.CANCELLED, true, "Cancelled by the sender.")

    fun close() {
        closed = true
        o.channel.close()
    }

    private fun send(buf: ByteArray) {
        if (closed || !o.channel.isOpen) return
        o.channel.send(buf)
    }

    private fun fail(code: String, fatal: Boolean, message: String?) {
        send(Frame.json(FrameType.ERROR, ErrorBody.serializer(), ErrorBody(code, fatal, message)))
        end(code, fatal, message)
        if (fatal) {
            o.scope.launch {
                drain.until(o.channel, o.lowWater)
                delay(100)
                o.channel.close()
            }
        }
    }

    private fun end(code: String, fatal: Boolean, message: String?) {
        if (closed && code == ErrorCodes.CLOSED) return
        closed = closed || fatal || code == ErrorCodes.CLOSED
        o.events.onError(code, fatal, message)
    }

    private suspend fun onFrame(data: ByteArray) {
        try {
            val f = Frame.decode(data)
            when (f.type) {
                FrameType.HELLO -> onHello(f.body(HelloReceiver.serializer()))
                FrameType.BITMAP -> onBitmap(f.fileIndex, f.payload)
                FrameType.ACK -> onAck(f.fileIndex, f.block)
                FrameType.NACK -> {
                    f.body(NackBody.serializer())
                    onNack(f.fileIndex, f.block)
                }
                FrameType.DONE -> {
                    val body = f.body(DoneBody.serializer())
                    if (body.ok == true) {
                        confirmed += f.fileIndex
                        o.events.onFileDone(f.fileIndex)
                        if (confirmed.size == o.files.size) o.events.onComplete()
                    }
                }
                FrameType.PAUSE -> {
                    isPaused = true
                    o.events.onPaused(true)
                }
                FrameType.RESUME -> {
                    isPaused = false
                    o.events.onResumed(true)
                    startPump()
                }
                FrameType.ERROR -> {
                    val e = f.body(ErrorBody.serializer())
                    end(e.code, e.fatal, e.message)
                    if (e.fatal) close()
                }
                else -> throw ProtocolException("unexpected frame ${f.type.code} from a receiver")
            }
        } catch (e: ProtocolException) {
            fail(ErrorCodes.PROTOCOL, true, e.message)
        } catch (e: IllegalArgumentException) {
            fail(ErrorCodes.PROTOCOL, true, e.message)
        }
    }

    private suspend fun onHello(h: HelloReceiver) {
        if (h.v != 1 || h.role != "receiver" || h.sessionId != o.sessionId || h.participantId.isEmpty() || h.capability.isEmpty()) {
            throw ProtocolException("bad HELLO")
        }
        if (!o.authorize(h.participantId, h.capability)) {
            fail(ErrorCodes.UNAUTHORIZED, true, "This device is not a joined receiver of the session.")
            return
        }
        participantId = h.participantId
        if (o.unavailable) {
            fail(ErrorCodes.FILE_UNREADABLE, true, "The sender no longer has these files.")
            return
        }
        o.events.onAuthorized(h.participantId)
        send(Frame.json(FrameType.HELLO, HelloSender.serializer(), HelloSender(sessionId = o.sessionId)))
        val meta =
            FileMeta(
                o.files.map {
                    FileMetaEntry(
                        it.index,
                        it.fileId,
                        it.transferId,
                        it.name,
                        it.size,
                        it.mime,
                        o.blockSize,
                        Wire.blockCount(it.size, o.blockSize)
                    )
                }
            )
        send(Frame.json(FrameType.FILE_META, FileMeta.serializer(), meta))
    }

    private suspend fun onBitmap(file: Int, bytes: ByteArray) {
        val f = o.files.firstOrNull { it.index == file }
        if (participantId == null || f == null) throw ProtocolException("BITMAP before HELLO or for an unknown file")
        val bm = Bitmap(Wire.blockCount(f.size, o.blockSize), bytes)
        bitmaps[file] = bm
        for (block in bm.missing()) queue.addLast(file to block)
        o.events.onProgress(file, verifiedBytes(file))
        if (bitmaps.size == o.files.size) {
            val sorted = queue.sortedWith(compareBy({ it.first }, { it.second }))
            queue.clear()
            queue.addAll(sorted)
            for (x in o.files) maybeDone(x.index)
            startPump()
        }
    }

    private suspend fun onAck(file: Int, block: Int) {
        val bm = bitmaps[file]
        if (bm == null || !inflight.remove(file to block)) throw ProtocolException("ACK for block $file:$block that is not in flight")
        bm.set(block)
        o.events.onProgress(file, verifiedBytes(file))
        maybeDone(file)
        startPump()
    }

    private fun onNack(file: Int, block: Int) {
        val key = file to block
        if (!inflight.remove(key)) throw ProtocolException("NACK for block $file:$block that is not in flight")
        counters.nacks++
        val n = (retries[key] ?: 0) + 1
        retries[key] = n
        if (n > o.maxRetries) {
            fail(ErrorCodes.CHECKSUM_RETRIES, true, "Block $block failed verification $n times.")
            return
        }
        queue.addFirst(key)
        startPump()
    }

    private suspend fun maybeDone(file: Int) {
        val bm = bitmaps[file]
        if (bm == null || !bm.full || file in doneSent) return
        doneSent += file
        val hash = o.hashes[file] ?: throw ProtocolException("no hash state for file $file")
        val sum =
            try {
                hash.value()
            } catch (e: IOException) {
                fail(ErrorCodes.FILE_UNREADABLE, true, e.message)
                return
            }
        send(Frame.json(FrameType.DONE, DoneBody.serializer(), DoneBody(sum), file = file.toLong()))
    }

    private fun startPump() {
        o.scope.launch(start = CoroutineStart.UNDISPATCHED) { pump() }
    }

    /** Sends queued blocks while the window and the channel buffer allow. */
    private suspend fun pump() {
        if (pumping) return
        pumping = true
        try {
            while (!closed && !isPaused && inflight.size < o.window) {
                val job = queue.removeFirstOrNull() ?: break
                if (bitmaps[job.first]?.has(job.second) == true) {
                    counters.verifiedResent++
                    continue
                }
                sendBlock(job.first, job.second)
            }
        } catch (e: IOException) {
            fail(ErrorCodes.FILE_UNREADABLE, true, e.message)
        } catch (e: SecurityException) {
            fail(ErrorCodes.FILE_UNREADABLE, true, e.message)
        } catch (e: ProtocolException) {
            fail(ErrorCodes.PROTOCOL, true, e.message)
        } finally {
            pumping = false
        }
    }

    private suspend fun sendBlock(file: Int, block: Int) {
        val f = o.files.firstOrNull { it.index == file } ?: throw ProtocolException("unknown file $file")
        val len = Wire.blockLength(f.size, block, o.blockSize)
        val offset = block.toLong() * o.blockSize
        val load: suspend () -> ByteArray = {
            val read = f.source.read(offset, len)
            if (read.size != len) throw FileChangedException("The file changed while it was being sent.")
            o.hashes[file]?.feed(offset, read)
            read
        }
        val cached = o.cache?.get(file, block, load) ?: load().let { CachedBlock(it, sha256(it)) }
        var data = cached.data
        if (o.corruptBlocks > 0) {
            o.corruptBlocks--
            data = data.copyOf()
            data[0] = (data[0].toInt() xor 0xFF).toByte()
        }
        inflight += file to block
        var off = 0
        while (true) {
            if (closed) return
            if (o.channel.bufferedAmount > o.highWater) drain.until(o.channel, o.lowWater)
            val first = off == 0
            val room = frameData - if (first) Wire.DIGEST_BYTES else 0
            val n = minOf(room, len - off)
            val last = off + n >= len
            val payload = ByteArray((if (first) Wire.DIGEST_BYTES else 0) + n)
            if (first) cached.sum.copyInto(payload, 0)
            data.copyInto(payload, if (first) Wire.DIGEST_BYTES else 0, off, off + n)
            send(
                Frame.encode(
                    FrameType.BLOCK,
                    flags = (if (first) Wire.FLAG_FIRST else 0) or (if (last) Wire.FLAG_LAST else 0),
                    file = file.toLong(),
                    block = block,
                    offset = off,
                    payload = payload
                )
            )
            counters.bytesSent += n
            off += n
            if (last) break
        }
        counters.blocksSent++
    }
}
