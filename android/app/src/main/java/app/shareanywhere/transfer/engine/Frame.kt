package app.shareanywhere.transfer.engine

import java.nio.ByteBuffer
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Wire format of the transfer protocol, version 1 (docs/TRANSFER_PROTOCOL.md §2), byte for byte the same as
 * `web/src/features/transfer/engine/frame.ts` and checked against shared/protocol/schemas/transfer-vectors.json.
 *
 * Every DataChannel message is one frame: a 20-byte big-endian header followed by the payload.
 *   0 u8 version (1) · 1 u8 type · 2 u16 flags · 4 u32 file · 8 u32 block · 12 u32 offset · 16 u32 payload length
 */
object Wire {
    const val VERSION = 1
    const val HEADER_BYTES = 20
    const val NO_FILE = 0xFFFFFFFFL
    const val BLOCK_SIZE = 4 * 1024 * 1024
    const val FRAME_BYTES = 64 * 1024
    const val DIGEST_BYTES = 32
    const val FLAG_FIRST = 1
    const val FLAG_LAST = 2

    /** JSON bodies: compact, keys in declaration order (the Web's JSON.stringify order), nulls omitted. */
    val json = Json {
        explicitNulls = false
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    /** Payload bytes for block data in one frame, given the peer's message limit. */
    fun dataPerFrame(maxMessageSize: Int?): Int {
        val limit = minOf(FRAME_BYTES, if (maxMessageSize != null && maxMessageSize > 0) maxMessageSize else FRAME_BYTES)
        return limit - HEADER_BYTES
    }

    /** Blocks in a file; an empty file has none. */
    fun blockCount(size: Long, blockSize: Int = BLOCK_SIZE): Int = ((size + blockSize - 1) / blockSize).toInt()

    fun blockLength(size: Long, index: Int, blockSize: Int = BLOCK_SIZE): Int =
        minOf(blockSize.toLong(), size - index.toLong() * blockSize).toInt()
}

enum class FrameType(val code: Int) {
    HELLO(1),
    FILE_META(2),
    BITMAP(3),
    BLOCK(4),
    ACK(5),
    NACK(6),
    PAUSE(7),
    RESUME(8),
    DONE(9),
    ERROR(10);

    val json: Boolean get() = this == HELLO || this == FILE_META || this == NACK || this == DONE || this == ERROR
    val empty: Boolean get() = this == ACK || this == PAUSE || this == RESUME

    companion object {
        fun of(code: Int): FrameType? = entries.firstOrNull { it.code == code }
    }
}

class ProtocolException(message: String) : Exception(message)

/** One decoded frame. [file] is unsigned (0..0xFFFFFFFF, [Wire.NO_FILE] when not about a file). */
class Frame(val type: FrameType, val flags: Int, val file: Long, val block: Int, val offset: Int, val payload: ByteArray) {
    val fileIndex: Int get() = if (file == Wire.NO_FILE) -1 else file.toInt()

    fun <T> body(serializer: KSerializer<T>): T {
        if (!type.json) throw ProtocolException("frame type ${type.code} does not carry JSON")
        val text =
            try {
                Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(payload)).toString()
            } catch (_: java.nio.charset.CharacterCodingException) {
                throw ProtocolException("invalid JSON payload")
            }
        return try {
            Wire.json.decodeFromString(serializer, text)
        } catch (_: Exception) {
            throw ProtocolException("invalid JSON payload")
        }
    }

    companion object {
        fun encode(
            type: FrameType,
            flags: Int = 0,
            file: Long = Wire.NO_FILE,
            block: Int = 0,
            offset: Int = 0,
            payload: ByteArray = EMPTY
        ): ByteArray {
            require(file in 0..0xFFFFFFFFL) { "file out of range" }
            require(block >= 0 && offset >= 0) { "block or offset out of range" }
            val buf = ByteBuffer.allocate(Wire.HEADER_BYTES + payload.size)
            buf.put(Wire.VERSION.toByte())
            buf.put(type.code.toByte())
            buf.putShort(flags.toShort())
            buf.putInt(file.toInt())
            buf.putInt(block)
            buf.putInt(offset)
            buf.putInt(payload.size)
            buf.put(payload)
            return buf.array()
        }

        fun <T> json(type: FrameType, serializer: KSerializer<T>, body: T, file: Long = Wire.NO_FILE, block: Int = 0): ByteArray {
            if (!type.json) throw ProtocolException("frame type ${type.code} does not carry JSON")
            return encode(
                type,
                file = file,
                block = block,
                payload = Wire.json.encodeToString(serializer, body).toByteArray(Charsets.UTF_8)
            )
        }

        /** Decodes one message; throws [ProtocolException] for anything malformed (the caller ends the connection). */
        fun decode(bytes: ByteArray): Frame {
            if (bytes.size < Wire.HEADER_BYTES) throw ProtocolException("frame shorter than its header")
            val b = ByteBuffer.wrap(bytes)
            val version = b.get().toInt() and 0xFF
            if (version != Wire.VERSION) throw ProtocolException("unsupported protocol version $version")
            val code = b.get().toInt() and 0xFF
            val type = FrameType.of(code) ?: throw ProtocolException("unknown frame type $code")
            val flags = b.short.toInt() and 0xFFFF
            val file = b.int.toLong() and 0xFFFFFFFFL
            val block = b.int
            val offset = b.int
            val length = b.int.toLong() and 0xFFFFFFFFL
            if (length != (bytes.size - Wire.HEADER_BYTES).toLong()) throw ProtocolException("payload length does not match the message")
            if (block < 0 || offset < 0) throw ProtocolException("block or offset out of range")
            if (type.empty && length != 0L) throw ProtocolException("control frame with a payload")
            if (type == FrameType.BLOCK && flags and Wire.FLAG_FIRST != 0 && length < Wire.DIGEST_BYTES) {
                throw ProtocolException("first block frame without its digest")
            }
            return Frame(type, flags, file, block, offset, bytes.copyOfRange(Wire.HEADER_BYTES, bytes.size))
        }

        private val EMPTY = ByteArray(0)
    }
}

// JSON bodies, fields in the Web's key order.
@Serializable
data class HelloReceiver(
    val v: Int = 1,
    val role: String = "receiver",
    @SerialName("session_id") val sessionId: String,
    @SerialName("participant_id") val participantId: String,
    val capability: String
)

@Serializable
data class HelloSender(val v: Int = 1, val role: String = "sender", @SerialName("session_id") val sessionId: String)

@Serializable
data class FileMetaEntry(
    val file: Int,
    @SerialName("file_id") val fileId: String,
    @SerialName("transfer_id") val transferId: String,
    val name: String,
    val size: Long,
    val mime: String,
    @SerialName("block_size") val blockSize: Int,
    @SerialName("block_count") val blockCount: Int
)

@Serializable
data class FileMeta(val files: List<FileMetaEntry>)

@Serializable
data class NackBody(val reason: String)

@Serializable
data class DoneBody(val sha256: String, val ok: Boolean? = null)

@Serializable
data class ErrorBody(val code: String, val fatal: Boolean, val message: String? = null)

/** ERROR codes (§2). "closed" is local: the channel closed without an ERROR frame. */
object ErrorCodes {
    const val UNAUTHORIZED = "unauthorized"
    const val PROTOCOL = "protocol"
    const val STORAGE_FULL = "storage_full"
    const val STORAGE_ERROR = "storage_error"
    const val FILE_UNREADABLE = "file_unreadable"
    const val CHECKSUM_RETRIES = "checksum_retries"
    const val FILE_HASH_MISMATCH = "file_hash_mismatch"
    const val CANCELLED = "cancelled"
    const val CLOSED = "closed"
}
