package app.shareanywhere.transfer.engine

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** End-to-end engine behaviour over an in-memory channel (docs/TRANSFER_PROTOCOL.md §3–§5), as the Web's engine.test.ts. */
class EngineTest {
    private val bs = 64 * 1024
    private val scopes = mutableListOf<CoroutineScope>()

    private fun scope() = confinedScope().also { scopes += it }

    @After
    fun tearDown() = scopes.forEach { it.cancel() }

    private class Rx {
        val sinks = HashMap<Int, MemorySink>()
        val persisted = HashMap<Int, Bitmap>()
        var complete = false
        val errors = mutableListOf<String>()
        val doneFiles = mutableListOf<Pair<Int, Boolean>>()
    }

    private class Tx {
        var complete = false
        val errors = mutableListOf<String>()
        var authorized: String? = null
    }

    private inner class Link(
        val data: List<ByteArray>,
        rx: Rx = Rx(),
        val capabilityOk: Boolean = true,
        cache: BlockCache? = null,
        sharedHashes: Map<Int, FileHash>? = null,
        corrupt: Int = 0,
        sourceOverride: List<FileSource>? = null,
        max: Int? = 65536,
        senderScope: CoroutineScope? = null
    ) {
        // A session's sender connections share one confined dispatcher (and with it the block cache).
        val s = senderScope ?: scope()
        val r = scope()
        val pair = MemChannel.pair(s, r, max)
        val tx = Tx()
        val rx = rx
        val sources = sourceOverride ?: data.map { MemorySource(it) }
        val files = sources.mapIndexed { i, src -> SenderFile(i, "f$i", "t$i", "file$i.bin", src.size, "application/octet-stream", src) }
        val hashes = sharedHashes ?: files.associate { it.index to FileHash(it.source, s) }
        val sender =
            SenderConnection(
                SenderOptions(
                    channel = pair.first,
                    scope = s,
                    sessionId = "s1",
                    files = files,
                    hashes = hashes,
                    authorize = { pid, cap -> capabilityOk && pid == "p1" && cap == "cap" },
                    events =
                    object : SenderEvents {
                        override fun onAuthorized(participantId: String) {
                            tx.authorized = participantId
                        }

                        override fun onComplete() {
                            tx.complete = true
                        }

                        override fun onError(code: String, fatal: Boolean, message: String?) {
                            tx.errors += code
                        }
                    },
                    cache = cache,
                    blockSize = bs,
                    corruptBlocks = corrupt
                )
            )
        val receiver =
            ReceiverConnection(
                ReceiverOptions(
                    channel = pair.second,
                    scope = r,
                    hello = HelloReceiver(sessionId = "s1", participantId = "p1", capability = "cap"),
                    prepare = { e ->
                        val sink = rx.sinks.getOrPut(e.file) { MemorySink(e.size) }
                        val bm = rx.persisted[e.file]?.copy() ?: Bitmap(e.blockCount)
                        PreparedFile(sink, bm, { b -> rx.persisted[e.file] = b.copy() })
                    },
                    events =
                    object : ReceiverEvents {
                        override fun onComplete() {
                            rx.complete = true
                        }

                        override fun onFileDone(file: Int, ok: Boolean) {
                            rx.doneFiles += file to ok
                        }

                        override fun onError(code: String, fatal: Boolean, message: String?) {
                            rx.errors += code
                        }
                    }
                )
            )

        fun start() = r.launch { receiver.start() }
    }

    @Test
    fun filesArriveVerifiedIncludingAnEmptyOneAndAPartialLastBlock() = runBlocking {
        val data = listOf(bytesOf(bs * 3 + 123, 1), ByteArray(0), bytesOf(bs - 1, 2))
        val l = Link(data)
        l.start()
        until { l.rx.complete && l.tx.complete }
        for (i in data.indices) assertArrayEquals(data[i], l.rx.sinks[i]!!.bytes)
        assertEquals("p1", l.tx.authorized)
        assertEquals(0, l.receiver.counters.duplicates)
        assertEquals(listOf(0 to true, 1 to true, 2 to true), l.rx.doneFiles.sortedBy { it.first })
        assertTrue(l.rx.errors.isEmpty() && l.tx.errors.isEmpty())
    }

    @Test
    fun aReconnectResumesOnlyTheMissingBlocks() = runBlocking {
        val data = listOf(bytesOf(bs * 10, 3))
        val rx = Rx()
        // An earlier connection verified blocks 0, 3 and 9 and persisted them.
        rx.sinks[0] = MemorySink(data[0].size.toLong())
        val bm = Bitmap(10)
        for (b in listOf(0, 3, 9)) {
            bm.set(b)
            data[0].copyInto(rx.sinks[0]!!.bytes, b * bs, b * bs, (b + 1) * bs)
        }
        rx.persisted[0] = bm
        val l = Link(data, rx)
        l.start()
        until { rx.complete && l.tx.complete }
        assertArrayEquals(data[0], rx.sinks[0]!!.bytes)
        assertEquals("only the 7 missing blocks are sent", 7, l.sender.counters.blocksSent)
        assertEquals(0, l.receiver.counters.duplicates)
        assertEquals(0, l.sender.counters.verifiedResent)
    }

    @Test
    fun aCorruptBlockIsNackedAndSentAgain() = runBlocking {
        val data = listOf(bytesOf(bs * 4, 4))
        val l = Link(data, corrupt = 2)
        l.start()
        until { l.rx.complete && l.tx.complete }
        assertArrayEquals(data[0], l.rx.sinks[0]!!.bytes)
        assertEquals(2, l.sender.counters.nacks)
        assertEquals(2, l.receiver.counters.nacksSent)
    }

    @Test
    fun repeatedChecksumFailuresEndTheTransfer() = runBlocking {
        val l = Link(listOf(bytesOf(bs * 2, 5)), corrupt = 10)
        l.start()
        until { ErrorCodes.CHECKSUM_RETRIES in l.tx.errors && ErrorCodes.CHECKSUM_RETRIES in l.rx.errors }
        assertEquals(false, l.rx.complete)
    }

    @Test
    fun aReceiverWithoutTheCapabilityIsRefused() = runBlocking {
        val l = Link(listOf(bytesOf(bs, 6)), capabilityOk = false)
        l.start()
        until { ErrorCodes.UNAUTHORIZED in l.rx.errors }
        assertEquals(null, l.tx.authorized)
        assertEquals(0, l.sender.counters.blocksSent)
    }

    @Test
    fun aFileThatChangedSinceItWasHashedFailsTheWholeFileCheck() = runBlocking {
        val sent = bytesOf(bs * 3, 7)
        val changed = sent.copyOf().also { it[bs + 5] = (it[bs + 5] + 1).toByte() }
        // The whole-file hash was taken over the earlier contents (a sequential pass that ran before the edit).
        val s = scope()
        val stale = FileHash(MemorySource(changed), s)
        s.launch { stale.value() }.join()
        val l = Link(listOf(sent), sharedHashes = mapOf(0 to stale))
        l.start()
        until { ErrorCodes.FILE_HASH_MISMATCH in l.rx.errors }
        assertEquals(listOf(0 to false), l.rx.doneFiles)
        assertEquals(false, l.rx.complete)
    }

    @Test
    fun pauseStopsNewBlocksAndResumeContinues() = runBlocking {
        val data = listOf(bytesOf(bs * 40, 8))
        val l = Link(data)
        l.pair.first.delayMs = 1
        l.start()
        until { l.sender.counters.blocksSent >= 2 }
        l.r.launch { l.receiver.pause() }.join()
        until { l.sender.isPaused }
        kotlinx.coroutines.delay(150)
        val sentWhilePaused = l.sender.counters.blocksSent
        kotlinx.coroutines.delay(150)
        assertTrue("at most the in-flight window completes while paused", l.sender.counters.blocksSent <= sentWhilePaused + 4)
        assertTrue(l.sender.counters.blocksSent < 40)
        l.r.launch { l.receiver.resume() }.join()
        until { l.rx.complete && l.tx.complete }
        assertArrayEquals(data[0], l.rx.sinks[0]!!.bytes)
    }

    @Test
    fun threeReceiversShareOneBlockCacheAndReadTheFileOnce() = runBlocking {
        val data = bytesOf(bs * 8, 9)
        val cache = BlockCache(64L * 1024 * 1024)
        val source = MemorySource(data)
        val senderScope = scope()
        val sharedHash = mapOf(0 to FileHash(source, senderScope))
        val links = (1..3).map {
            Link(listOf(data), cache = cache, sharedHashes = sharedHash, sourceOverride = listOf(source), senderScope = senderScope)
        }
        links.forEach { it.start() }
        until { links.all { it.rx.complete && it.tx.complete } }
        links.forEach { assertArrayEquals(data, it.rx.sinks[0]!!.bytes) }
        assertEquals("each block read once for all receivers", 8, cache.reads)
        assertEquals(8, source.reads)
    }

    @Test
    fun smallMessageLimitsSplitBlocksIntoMoreFrames() = runBlocking {
        val data = listOf(bytesOf(bs * 2 + 5, 10))
        val l = Link(data, max = 16384)
        l.start()
        until { l.rx.complete && l.tx.complete }
        assertArrayEquals(data[0], l.rx.sinks[0]!!.bytes)
    }
}
