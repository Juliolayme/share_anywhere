package app.shareanywhere.transfer.engine

import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Where received bytes go (a SAF document, or memory in tests). */
interface Sink {
    suspend fun write(offset: Long, data: ByteArray)

    suspend fun read(offset: Long, length: Int): ByteArray

    /** Makes writes durable before the block is acknowledged. */
    suspend fun flush()
}

/** The device ran out of space while writing (ERROR storage_full). */
class StorageFullException(message: String) : IOException(message)

/** A file prepared for receiving: its sink and persisted bitmap (empty on a first connect). */
class PreparedFile(val sink: Sink, val bitmap: Bitmap, val persist: suspend (Bitmap) -> Unit, val verified: Boolean = false)

class ReceiverCounters {
    var blocksReceived = 0

    /** Blocks that arrived although already verified (must stay 0 across a resume). */
    var duplicates = 0
    var nacksSent = 0
}

interface ReceiverEvents {
    fun onMeta(files: List<FileMetaEntry>) {}

    fun onProgress(file: Int, verifiedBytes: Long) {}

    fun onVerifying(file: Int, hashedBytes: Long) {}

    fun onFileDone(file: Int, ok: Boolean) {}

    fun onComplete() {}

    fun onPaused(byPeer: Boolean) {}

    fun onResumed(byPeer: Boolean) {}

    fun onError(code: String, fatal: Boolean, message: String?) {}
}

class ReceiverOptions(
    val channel: TransferChannel,
    val scope: CoroutineScope,
    val hello: HelloReceiver,
    val prepare: suspend (FileMetaEntry) -> PreparedFile,
    val events: ReceiverEvents = object : ReceiverEvents {},
    /** Most blocks assembled at once; more means the sender ignored the window. */
    val maxAssembling: Int = 8
)

/**
 * One receiver ↔ sender connection (docs/TRANSFER_PROTOCOL.md §3–§5), the Kotlin twin of the Web's
 * ReceiverConnection. Frames are handled in arrival order on [ReceiverOptions.scope]'s confined dispatcher; block
 * completion (hash, write, flush, persist, ACK) and control frames run one at a time, in order.
 */
class ReceiverConnection(private val o: ReceiverOptions) {
    val counters = ReceiverCounters()
    private class Target(val entry: FileMetaEntry, val prep: PreparedFile)
    private class Assembly(val digest: ByteArray, val data: ByteArray) {
        var received = 0
    }

    private val files = HashMap<Int, Target>()
    private val assembling = HashMap<Pair<Int, Int>, Assembly>()
    private val work = Channel<suspend () -> Unit>(Channel.UNLIMITED)
    private val done = HashSet<Int>()
    var isPaused = false
        private set
    private var closed = false
    private var muted = false
    private var authorized = false
    private val drain = Drain()

    init {
        o.channel.setListener(
            object : TransferChannel.Listener {
                override fun onMessage(data: ByteArray) = onFrame(data)

                override fun onBufferedAmountChange() = drain.signal()

                override fun onClose() {
                    drain.signal()
                    end(ErrorCodes.CLOSED, false, null)
                }
            }
        )
        // The serial work queue: control frames and completed blocks, strictly in arrival order.
        o.scope.launch {
            for (job in work) {
                try {
                    job()
                } catch (e: ProtocolException) {
                    fail(ErrorCodes.PROTOCOL, true, e.message)
                } catch (e: IllegalArgumentException) {
                    fail(ErrorCodes.PROTOCOL, true, e.message)
                } catch (e: StorageFullException) {
                    fail(ErrorCodes.STORAGE_FULL, true, e.javaClass.simpleName)
                } catch (e: IOException) {
                    // The exception class only: storage messages can carry local paths, and ERROR goes to the peer.
                    fail(ErrorCodes.STORAGE_ERROR, true, e.javaClass.simpleName)
                } catch (e: SecurityException) {
                    fail(ErrorCodes.STORAGE_ERROR, true, e.javaClass.simpleName)
                }
            }
        }
    }

    /** Call once the channel is open. */
    fun start() = send(Frame.json(FrameType.HELLO, HelloReceiver.serializer(), o.hello))

    fun verifiedBytes(file: Int): Long {
        val t = files[file] ?: return 0
        var n = 0L
        for (i in 0 until t.prep.bitmap.size) if (t.prep.bitmap.has(i)) n += Wire.blockLength(t.entry.size, i, t.entry.blockSize)
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
    }

    fun cancel() = fail(ErrorCodes.CANCELLED, true, "Cancelled by the receiver.")

    fun close() {
        closed = true
        work.close()
        o.channel.close()
    }

    /** The receiver is going away: send nothing more. */
    fun mute() {
        muted = true
    }

    private fun send(buf: ByteArray) {
        if (closed || muted || !o.channel.isOpen) return
        o.channel.send(buf)
    }

    private fun fail(code: String, fatal: Boolean, message: String?) {
        send(Frame.json(FrameType.ERROR, ErrorBody.serializer(), ErrorBody(code, fatal, message)))
        end(code, fatal, message)
        if (fatal && !muted) {
            o.scope.launch {
                drain.until(o.channel, 0)
                delay(100)
                o.channel.close()
            }
        }
    }

    private fun end(code: String, fatal: Boolean, message: String?) {
        if (closed && code == ErrorCodes.CLOSED) return
        closed = closed || fatal || code == ErrorCodes.CLOSED
        if (closed) work.close()
        o.events.onError(code, fatal, message)
    }

    private fun onFrame(data: ByteArray) {
        val f =
            try {
                Frame.decode(data)
            } catch (e: ProtocolException) {
                fail(ErrorCodes.PROTOCOL, true, e.message)
                return
            }
        if (f.type == FrameType.BLOCK) {
            try {
                onBlockFrame(f)
            } catch (e: ProtocolException) {
                fail(ErrorCodes.PROTOCOL, true, e.message)
            }
            return
        }
        work.trySend { onControl(f) }
    }

    private suspend fun onControl(f: Frame) {
        when (f.type) {
            FrameType.HELLO -> {
                val h = f.body(HelloSender.serializer())
                if (h.v != 1 || h.role != "sender" || h.sessionId != o.hello.sessionId) throw ProtocolException("bad HELLO")
                authorized = true
            }
            FrameType.FILE_META -> {
                if (!authorized) throw ProtocolException("FILE_META before HELLO")
                val meta = f.body(FileMeta.serializer())
                for (e in meta.files) {
                    if (e.blockSize <= 0 ||
                        e.blockCount != Wire.blockCount(e.size, e.blockSize)
                    ) {
                        throw ProtocolException("inconsistent FILE_META")
                    }
                }
                o.events.onMeta(meta.files)
                for (entry in meta.files) {
                    val prep = o.prepare(entry)
                    if (prep.bitmap.size != entry.blockCount) throw ProtocolException("stored bitmap does not match the file")
                    files[entry.file] = Target(entry, prep)
                    if (prep.verified) done += entry.file
                    send(Frame.encode(FrameType.BITMAP, file = entry.file.toLong(), payload = prep.bitmap.bytes))
                    o.events.onProgress(entry.file, verifiedBytes(entry.file))
                }
            }
            FrameType.DONE -> verifyFile(f.fileIndex, f.body(DoneBody.serializer()).sha256)
            FrameType.PAUSE -> {
                isPaused = true
                o.events.onPaused(true)
            }
            FrameType.RESUME -> {
                isPaused = false
                o.events.onResumed(true)
            }
            FrameType.ERROR -> {
                val e = f.body(ErrorBody.serializer())
                end(e.code, e.fatal, e.message)
                if (e.fatal) close()
            }
            else -> throw ProtocolException("unexpected frame ${f.type.code} from a sender")
        }
    }

    private fun onBlockFrame(f: Frame) {
        val file = f.fileIndex
        val block = f.block
        val key = file to block
        val target = files[file] ?: throw ProtocolException("block for unknown file $file")
        if (block >= target.entry.blockCount) throw ProtocolException("block $block outside the file")
        val len = Wire.blockLength(target.entry.size, block, target.entry.blockSize)
        var a = assembling[key]
        var start = 0
        if (f.flags and Wire.FLAG_FIRST != 0) {
            if (f.offset != 0 || a != null) throw ProtocolException("unexpected first frame")
            if (assembling.size >= o.maxAssembling) throw ProtocolException("too many blocks in flight")
            a = Assembly(f.payload.copyOfRange(0, Wire.DIGEST_BYTES), ByteArray(len))
            assembling[key] = a
            start = Wire.DIGEST_BYTES
        }
        val n = f.payload.size - start
        if (a == null || f.offset != a.received || f.offset + n > len) throw ProtocolException("block frame out of place")
        f.payload.copyInto(a.data, f.offset, start, f.payload.size)
        a.received += n
        if (f.flags and Wire.FLAG_LAST == 0) return
        assembling.remove(key)
        val complete = a
        work.trySend { completeBlock(file, block, len, complete) }
    }

    private suspend fun completeBlock(file: Int, block: Int, len: Int, a: Assembly) {
        val t = files[file] ?: throw ProtocolException("block for unknown file $file")
        counters.blocksReceived++
        if (t.prep.bitmap.has(block)) {
            counters.duplicates++
            send(Frame.encode(FrameType.ACK, file = file.toLong(), block = block))
            return
        }
        if (a.received != len) return nack(file, block, "length")
        if (!equalBytes(sha256(a.data), a.digest)) return nack(file, block, "checksum")
        t.prep.sink.write(block.toLong() * t.entry.blockSize, a.data)
        t.prep.sink.flush()
        t.prep.bitmap.set(block)
        t.prep.persist(t.prep.bitmap)
        send(Frame.encode(FrameType.ACK, file = file.toLong(), block = block)) // only after write + verify + persist
        o.events.onProgress(file, verifiedBytes(file))
    }

    private fun nack(file: Int, block: Int, reason: String) {
        counters.nacksSent++
        send(Frame.json(FrameType.NACK, NackBody.serializer(), NackBody(reason), file = file.toLong(), block = block))
    }

    private suspend fun verifyFile(file: Int, expected: String) {
        val t = files[file] ?: throw ProtocolException("DONE for unknown file $file")
        if (!t.prep.bitmap.full) throw ProtocolException("DONE before every block was verified")
        if (file in done) {
            send(Frame.json(FrameType.DONE, DoneBody.serializer(), DoneBody(expected, true), file = file.toLong()))
            finish(file)
            return
        }
        val actual = hashStream(t.entry.size, { off, n -> t.prep.sink.read(off, n) }, { o.events.onVerifying(file, it) })
        val ok = actual == expected
        send(Frame.json(FrameType.DONE, DoneBody.serializer(), DoneBody(actual, ok), file = file.toLong()))
        if (!ok) {
            fail(ErrorCodes.FILE_HASH_MISMATCH, true, "The received file does not match the sender’s file.")
            o.events.onFileDone(file, false)
            return
        }
        finish(file)
    }

    private fun finish(file: Int) {
        done += file
        o.events.onFileDone(file, true)
        if (done.size == files.size) o.events.onComplete()
    }
}
