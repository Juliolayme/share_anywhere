package app.shareanywhere.transfer.engine

import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** A confined (single-thread) scope, as the runtime gives each transfer. */
fun confinedScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Executors.newSingleThreadExecutor().asCoroutineDispatcher())

/** In-memory ordered reliable channel pair; deliveries hop through the peer's scope, like SCTP. */
class MemChannel(private val scope: CoroutineScope, override val maxMessageSize: Int?) : TransferChannel {
    lateinit var peer: MemChannel

    @Volatile override var bufferedAmount: Long = 0

    @Volatile var state = "open"

    @Volatile var sent = 0
    private var listener: TransferChannel.Listener? = null

    /** Test hook: delay each delivery (a slow link). */
    @Volatile var delayMs = 0L

    override val isOpen: Boolean get() = state == "open"

    override fun setListener(listener: TransferChannel.Listener?) {
        this.listener = listener
    }

    override fun send(data: ByteArray): Boolean {
        check(isOpen) { "channel closed" }
        val max = maxMessageSize
        check(max == null || data.size <= max) { "message of ${data.size} bytes over the limit" }
        sent++
        synchronized(this) { bufferedAmount += data.size }
        val copy = data.copyOf()
        val d = delayMs
        peer.scope.launch {
            if (d > 0) delay(d)
            synchronized(this@MemChannel) { bufferedAmount -= data.size }
            scope.launch { listener?.onBufferedAmountChange() }
            if (peer.state != "closed") peer.listener?.onMessage(copy)
        }
        return true
    }

    override fun close() {
        if (state != "open") return
        state = "closing"
        // Queued deliveries go first (same ordered dispatcher), then both ends close.
        peer.scope.launch {
            delay(delayMs + 1)
            state = "closed"
            peer.state = "closed"
            scope.launch { listener?.onClose() }
            peer.listener?.onClose()
        }
    }

    companion object {
        fun pair(a: CoroutineScope, b: CoroutineScope, max: Int? = 65536): Pair<MemChannel, MemChannel> {
            val x = MemChannel(a, max)
            val y = MemChannel(b, max)
            x.peer = y
            y.peer = x
            return x to y
        }
    }
}

class MemorySink(size: Long) : Sink {
    val bytes = ByteArray(size.toInt())
    var writes = 0

    override suspend fun write(offset: Long, data: ByteArray) {
        writes++
        data.copyInto(bytes, offset.toInt())
    }

    override suspend fun read(offset: Long, length: Int): ByteArray = bytes.copyOfRange(offset.toInt(), offset.toInt() + length)

    override suspend fun flush() {}
}

class MemorySource(val data: ByteArray) : FileSource {
    var reads = 0
    override val size: Long get() = data.size.toLong()

    override suspend fun read(offset: Long, length: Int): ByteArray {
        reads++
        return data.copyOfRange(offset.toInt(), minOf(data.size, offset.toInt() + length))
    }
}

/** Deterministic pseudo-random bytes (xorshift), as the Web's bytesOf. */
fun bytesOf(size: Int, seed: Int = 1): ByteArray {
    val out = ByteArray(size)
    var x = if (seed == 0) 1 else seed
    for (i in 0 until size) {
        x = x xor (x shl 13)
        x = x xor (x ushr 17)
        x = x xor (x shl 5)
        out[i] = (x and 0xFF).toByte()
    }
    return out
}

suspend fun until(timeoutMs: Long = 20_000, cond: () -> Boolean) = withTimeout(timeoutMs) {
    while (!cond()) delay(2)
}
