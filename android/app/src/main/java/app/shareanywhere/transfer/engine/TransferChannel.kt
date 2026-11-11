package app.shareanywhere.transfer.engine

import kotlinx.coroutines.CompletableDeferred

/**
 * The slice of a WebRTC DataChannel the engine uses (`sa-transfer/1`, ordered, reliable, binary), so the engine runs
 * over an in-memory pair in tests. Listener callbacks must be delivered on the connection's confined dispatcher.
 */
interface TransferChannel {
    val bufferedAmount: Long
    val isOpen: Boolean

    /** Largest message the peer accepts (SCTP max message size); null when unknown. */
    val maxMessageSize: Int?

    /** Queues one message; false when the channel is not open. */
    fun send(data: ByteArray): Boolean

    fun close()

    fun setListener(listener: Listener?)

    interface Listener {
        fun onMessage(data: ByteArray)

        /** bufferedAmount dropped (the engine checks it against its low-water mark). */
        fun onBufferedAmountChange()

        fun onClose()
    }
}

/**
 * Waits until bufferedAmount drops to [low] or the channel closes; the engine calls [signal] on every change. Several
 * coroutines may wait at once (the block pump and a fatal error's close), so every waiter is woken by each signal.
 */
class Drain {
    private val waiters = ArrayList<CompletableDeferred<Unit>>()

    suspend fun until(channel: TransferChannel, low: Long) {
        while (channel.isOpen && channel.bufferedAmount > low) {
            val w = CompletableDeferred<Unit>()
            synchronized(waiters) { waiters += w }
            try {
                if (!channel.isOpen || channel.bufferedAmount <= low) break
                w.await()
            } finally {
                synchronized(waiters) { waiters -= w }
            }
        }
    }

    fun signal() {
        val all = synchronized(waiters) { waiters.toList() }
        all.forEach { it.complete(Unit) }
    }
}
