package app.shareanywhere.transfer.engine

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertTrue
import org.junit.Test

class DrainTest {
    private class FakeChannel : TransferChannel {
        override var bufferedAmount = 1_000L
        override var isOpen = true
        override val maxMessageSize: Int? = null

        override fun send(data: ByteArray) = true

        override fun close() {}

        override fun setListener(listener: TransferChannel.Listener?) {}
    }

    @Test
    fun everyWaiterWakesWhenTheBufferDrains() = runTest {
        // The block pump and a fatal error's close can wait at the same time: one signal must release both.
        val ch = FakeChannel()
        val drain = Drain()
        val pump = async { drain.until(ch, 100) }
        val closer = async { drain.until(ch, 0) }
        yield()
        ch.bufferedAmount = 0
        drain.signal()
        pump.await()
        closer.await()
        assertTrue(pump.isCompleted && closer.isCompleted)
    }
}
