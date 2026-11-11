package app.shareanywhere.transfer.engine

import java.security.MessageDigest

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it.toInt() and 0xFF) }

fun sha256(data: ByteArray, offset: Int = 0, length: Int = data.size): ByteArray =
    MessageDigest.getInstance("SHA-256").apply { update(data, offset, length) }.digest()

/** Constant-time comparison (digests). */
fun equalBytes(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

/** Whole-file SHA-256 fed strictly in order; ignores bytes already hashed and refuses gaps. */
class StreamHasher {
    private val md = MessageDigest.getInstance("SHA-256")
    var position: Long = 0
        private set

    fun update(offset: Long, data: ByteArray, length: Int = data.size): Boolean {
        if (offset > position) return false
        val skip = position - offset
        if (skip >= length) return true
        md.update(data, skip.toInt(), (length - skip).toInt())
        position += length - skip
        return true
    }

    fun hex(): String = md.digest().hex()
}

/** Hashes [size] bytes read through [read] in chunks, reporting progress. */
suspend fun hashStream(
    size: Long,
    read: suspend (offset: Long, length: Int) -> ByteArray,
    onProgress: (Long) -> Unit = {},
    chunk: Int = 4 *
        1024 *
        1024
): String {
    val h = StreamHasher()
    var off = 0L
    while (off < size) {
        val data = read(off, minOf(chunk.toLong(), size - off).toInt())
        if (data.isEmpty()) throw java.io.IOException("short read at $off")
        h.update(off, data)
        off += data.size
        onProgress(off)
    }
    return h.hex()
}
