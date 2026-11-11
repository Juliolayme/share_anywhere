package app.shareanywhere.transfer.engine

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Android engine reproduces shared/protocol/schemas/transfer-vectors.json byte for byte (docs/TRANSFER_PROTOCOL.md
 * §8): every frame, the bitmap encodings, block and file SHA-256 of the deterministic pattern, and frame counts.
 */
class VectorsTest {
    private val root = File(requireNotNull(System.getProperty("sa.repoRoot")) { "sa.repoRoot is set by app/build.gradle.kts" })
    private val v: JsonObject = Json.parseToJsonElement(File(root, "shared/protocol/schemas/transfer-vectors.json").readText()).jsonObject

    private fun pattern(n: Int, from: Long = 0) = ByteArray(n) { i -> (((from + i) * 31 + 7) and 0xFF).toByte() }

    private fun frame(name: String) = v["frames"]!!.jsonArray.map {
        it.jsonObject
    }.single { it["name"]!!.jsonPrimitive.content == name }["hex"]!!.jsonPrimitive.content

    @Test
    fun framesMatchTheSharedVectors() {
        val blockSize = 65536
        val size = 200_000L
        val file = pattern(size.toInt())
        val first = file.copyOfRange(0, blockSize)
        val firstPayload = sha256(first) + first.copyOfRange(0, 16)
        val bm = Bitmap(10).apply { listOf(0, 3, 9).forEach { set(it) } }
        val cases =
            mapOf(
                "HELLO receiver" to
                    Frame.json(
                        FrameType.HELLO,
                        HelloReceiver.serializer(),
                        HelloReceiver(sessionId = "s1", participantId = "p1", capability = "c1")
                    ),
                "HELLO sender" to Frame.json(FrameType.HELLO, HelloSender.serializer(), HelloSender(sessionId = "s1")),
                "FILE_META" to
                    Frame.json(
                        FrameType.FILE_META,
                        FileMeta.serializer(),
                        FileMeta(listOf(FileMetaEntry(0, "f1", "t1", "a.bin", size, "application/octet-stream", blockSize, 4)))
                    ),
                "BITMAP file 0, blocks {0,3,9} of 10" to Frame.encode(FrameType.BITMAP, file = 0, payload = bm.bytes),
                "BLOCK first frame (digest + first 16 bytes), file 0 block 0" to
                    Frame.encode(FrameType.BLOCK, flags = Wire.FLAG_FIRST, file = 0, block = 0, offset = 0, payload = firstPayload),
                "BLOCK last frame, file 0 block 3 at offset 4096, 8 bytes" to
                    Frame.encode(
                        FrameType.BLOCK,
                        flags = Wire.FLAG_LAST,
                        file = 0,
                        block = 3,
                        offset = 4096,
                        payload = pattern(
                            8,
                            3L * blockSize + 4096
                        )
                    ),
                "ACK file 0 block 2" to Frame.encode(FrameType.ACK, file = 0, block = 2),
                "NACK file 0 block 2 checksum" to
                    Frame.json(FrameType.NACK, NackBody.serializer(), NackBody("checksum"), file = 0, block = 2),
                "PAUSE" to Frame.encode(FrameType.PAUSE),
                "RESUME" to Frame.encode(FrameType.RESUME),
                "DONE file 0 from the sender" to Frame.json(FrameType.DONE, DoneBody.serializer(), DoneBody(sha256(file).hex()), file = 0),
                "ERROR cancelled" to Frame.json(FrameType.ERROR, ErrorBody.serializer(), ErrorBody("cancelled", true))
            )
        assertEquals(v["frames"]!!.jsonArray.size, cases.size)
        for ((name, bytes) in cases) {
            assertEquals(name, frame(name), bytes.hex())
            // Every vector decodes back to the same bytes.
            val f = Frame.decode(bytes)
            assertEquals(name, bytes.hex(), Frame.encode(f.type, f.flags, f.file, f.block, f.offset, f.payload).hex())
        }
    }

    @Test
    fun bitmapsFileHashesAndFramingMatch() {
        for (b in v["bitmaps"]!!.jsonArray.map { it.jsonObject }) {
            val bm = Bitmap(b["blocks"]!!.jsonPrimitive.int)
            b["set"]!!.jsonArray.forEach { bm.set(it.jsonPrimitive.int) }
            assertEquals(b["hex"]!!.jsonPrimitive.content, bm.bytes.hex())
            b["missing"]?.let { m -> assertEquals(m.jsonArray.map { it.jsonPrimitive.int }, bm.missing()) }
            b["missing_count"]?.let { assertEquals(it.jsonPrimitive.int, bm.missing().size) }
        }
        val f = v["file"]!!.jsonObject
        val size = f["size"]!!.jsonPrimitive.long
        val bs = f["block_size"]!!.jsonPrimitive.int
        val data = pattern(size.toInt())
        assertEquals(f["block_count"]!!.jsonPrimitive.int, Wire.blockCount(size, bs))
        val sums = (0 until Wire.blockCount(size, bs)).map { i -> sha256(data, i * bs, Wire.blockLength(size, i, bs)).hex() }
        assertEquals(f["block_sha256"]!!.jsonArray.map { it.jsonPrimitive.content }, sums)
        assertEquals(f["sha256"]!!.jsonPrimitive.content, sha256(data).hex())
        val h = StreamHasher()
        // Fed out of order with overlaps, the stream hash still equals the whole-file hash.
        h.update(0, data.copyOfRange(0, 1000))
        assertEquals(false, h.update(5000, data.copyOfRange(5000, 6000)))
        h.update(500, data.copyOfRange(500, size.toInt()))
        assertEquals(f["sha256"]!!.jsonPrimitive.content, h.hex())
        assertEquals(v["empty_file_sha256"]!!.jsonPrimitive.content, StreamHasher().hex())
        for (x in v["framing"]!!.jsonArray.map { it.jsonObject }) {
            val per = Wire.dataPerFrame(x["max_message_size"]!!.jsonPrimitive.int)
            assertEquals(x["data_per_frame"]!!.jsonPrimitive.int, per)
            val len = x["block_length"]!!.jsonPrimitive.int
            assertEquals(x["frames"]!!.jsonPrimitive.int, (len + Wire.DIGEST_BYTES + per - 1) / per)
        }
    }
}
