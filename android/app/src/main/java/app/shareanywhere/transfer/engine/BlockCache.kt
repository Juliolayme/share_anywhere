package app.shareanywhere.transfer.engine

import kotlinx.coroutines.CompletableDeferred

/** A block read from the file with its SHA-256, shared by every receiver's connection. Never modify [data]. */
class CachedBlock(val data: ByteArray, val sum: ByteArray)

/**
 * Sender-side block cache shared by the connections to all receivers of a session (docs/TRANSFER_PROTOCOL.md §5.1):
 * least recently used blocks are evicted beyond [maxBytes], and concurrent requests for the same block share one
 * read and one hash. Used from the sender's confined dispatcher only (no locking).
 */
class BlockCache(val maxBytes: Long = DEFAULT_BYTES) {
    private val entries = LinkedHashMap<Long, CachedBlock>(16, 0.75f, true)
    private val pending = HashMap<Long, CompletableDeferred<CachedBlock>>()
    var bytes: Long = 0
        private set
    var reads = 0
        private set
    var hits = 0
        private set
    var evictions = 0
        private set

    suspend fun get(file: Int, block: Int, load: suspend () -> ByteArray): CachedBlock {
        val key = (file.toLong() shl 32) or (block.toLong() and 0xFFFFFFFFL)
        entries[key]?.let {
            hits++
            return it
        }
        pending[key]?.let {
            hits++
            return it.await()
        }
        val d = CompletableDeferred<CachedBlock>()
        pending[key] = d
        try {
            reads++
            val data = load()
            val entry = CachedBlock(data, sha256(data))
            insert(key, entry)
            d.complete(entry)
            return entry
        } catch (e: Throwable) {
            d.completeExceptionally(e)
            throw e
        } finally {
            pending.remove(key)
        }
    }

    fun clear() {
        entries.clear()
        bytes = 0
    }

    private fun insert(key: Long, entry: CachedBlock) {
        val size = entry.data.size.toLong()
        if (size > maxBytes) return
        entries[key] = entry
        bytes += size
        val it = entries.entries.iterator()
        while (bytes > maxBytes && it.hasNext()) {
            val e = it.next()
            it.remove()
            bytes -= e.value.data.size
            evictions++
        }
    }

    companion object {
        /** 64 MiB, as on the Web; never less than one block. */
        const val DEFAULT_BYTES = 64L * 1024 * 1024
    }
}
