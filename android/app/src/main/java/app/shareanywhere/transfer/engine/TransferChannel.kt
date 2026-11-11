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

/** Waits until bufferedAmount drops to [low] or the channel closes; the engine calls [signal] on every change. */
class Drain {
    private var waiter: CompletableDeferred<Unit>? = null

    suspend fun until(channel: TransferChannel, low: Long) {
        while (channel.isOpen && channel.bufferedAmount > low) {
            val w = CompletableDeferred<Unit>()
            waiter = w
            if (!channel.isOpen || channel.bufferedAmount <= low) break
            w.await()
        }
        waiter = null
    }

    fun signal() {
        waiter?.complete(Unit)
    }
}
