package app.shareanywhere.transfer.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FrameTest {
    private fun rejects(bytes: ByteArray) {
        try {
            Frame.decode(bytes)
            fail("accepted a malformed frame")
        } catch (_: ProtocolException) {
        }
    }

    @Test
    fun malformedFramesAreProtocolErrors() {
        rejects(ByteArray(10))
        rejects(Frame.encode(FrameType.ACK).also { it[0] = 2 })
        rejects(Frame.encode(FrameType.ACK).also { it[1] = 11 })
        rejects(Frame.encode(FrameType.ACK).also { it[1] = 0 })
        rejects(Frame.encode(FrameType.HELLO, payload = ByteArray(3)).copyOf(22))
        rejects(Frame.encode(FrameType.PAUSE, payload = ByteArray(1)))
        rejects(Frame.encode(FrameType.BLOCK, flags = Wire.FLAG_FIRST, file = 0, payload = ByteArray(31)))
        rejects(Frame.encode(FrameType.ACK, block = 0).also { it[8] = 0x80.toByte() })
    }

    @Test
    fun theUnsignedFileIndexRoundTrips() {
        val f = Frame.decode(Frame.encode(FrameType.PAUSE))
        assertEquals(Wire.NO_FILE, f.file)
        assertEquals(-1, f.fileIndex)
        assertEquals(7, Frame.decode(Frame.encode(FrameType.ACK, file = 7, block = 3)).fileIndex)
    }

    @Test
    fun jsonBodiesAreCheckedAndInvalidJsonIsAProtocolError() {
        val bad = Frame.encode(FrameType.NACK, payload = byteArrayOf(0xC3.toByte(), 0x28))
        try {
            Frame.decode(bad).body(NackBody.serializer())
            fail()
        } catch (_: ProtocolException) {
        }
        try {
            Frame.decode(Frame.encode(FrameType.ACK)).body(NackBody.serializer())
            fail()
        } catch (_: ProtocolException) {
        }
    }

    @Test
    fun sizesFollowTheProtocol() {
        assertEquals(65516, Wire.dataPerFrame(null))
        assertEquals(16364, Wire.dataPerFrame(16384))
        assertEquals(65516, Wire.dataPerFrame(1 shl 20))
        assertEquals(0, Wire.blockCount(0))
        assertEquals(5120, Wire.blockCount(20L * 1024 * 1024 * 1024))
        assertEquals(1, Wire.blockLength(Wire.BLOCK_SIZE + 1L, 1))
    }

    @Test
    fun bitmapsRejectBitsPastTheEnd() {
        try {
            Bitmap(10, byteArrayOf(0, 0x04))
            fail()
        } catch (_: IllegalArgumentException) {
        }
        val b = Bitmap(10, byteArrayOf(0x09, 0x02))
        assertEquals(3, b.count)
        assertTrue(b.has(9))
        assertFalse(b.set(3))
        assertTrue(b.set(4))
        assertFalse(b.full)
    }
}
