package app.shareanywhere.transfer.engine

/**
 * Completed-block bitmap (docs/TRANSFER_PROTOCOL.md §4): bit i is block i, least significant bit first.
 * 20 GB / 4 MiB = 5,120 blocks → 640 bytes. Bits past the last block must be zero.
 */
class Bitmap(val size: Int, bytes: ByteArray? = null) {
    val bytes: ByteArray = ByteArray((size + 7) / 8)
    var count: Int = 0
        private set

    init {
        require(size >= 0) { "bitmap size" }
        if (bytes != null) {
            require(bytes.size == this.bytes.size) { "bitmap of $size blocks needs ${this.bytes.size} bytes, got ${bytes.size}" }
            bytes.copyInto(this.bytes)
            val rem = size % 8
            val tail = if (rem != 0 && this.bytes.isNotEmpty()) (this.bytes.last().toInt() and 0xFF) shr rem else 0
            require(tail == 0) { "bits set past the last block" }
            for (i in 0 until size) if (has(i)) count++
        }
    }

    fun has(i: Int): Boolean = i in 0 until size && ((bytes[i shr 3].toInt() shr (i and 7)) and 1) == 1

    /** Marks block i; returns true when it was not already set. */
    fun set(i: Int): Boolean {
        require(i in 0 until size) { "block $i outside 0..${size - 1}" }
        if (has(i)) return false
        bytes[i shr 3] = (bytes[i shr 3].toInt() or (1 shl (i and 7))).toByte()
        count++
        return true
    }

    val full: Boolean get() = count == size

    /** Missing indices, ascending. */
    fun missing(): List<Int> = (0 until size).filter { !has(it) }

    fun copy(): Bitmap = Bitmap(size, bytes)
}
