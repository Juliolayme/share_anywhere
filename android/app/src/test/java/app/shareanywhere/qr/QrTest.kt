package app.shareanywhere.qr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrTest {
    /** Renders [m] as a camera-like luminance plane: [scale] pixels per module, a quiet zone, dark on light. */
    private fun render(m: QrMatrix, scale: Int = 6, quiet: Int = 4, invert: Boolean = false): Triple<ByteArray, Int, Int> {
        val n = (m.size + quiet * 2) * scale
        val out = ByteArray(n * n)
        for (y in 0 until n) {
            for (x in 0 until n) {
                val mx = x / scale - quiet
                val my = y / scale - quiet
                val dark = mx in 0 until m.size && my in 0 until m.size && m[mx, my]
                out[y * n + x] = (if (dark != invert) 20 else 235).toByte()
            }
        }
        return Triple(out, n, n)
    }

    @Test
    fun aJoinLinkRoundTripsThroughEncodeAndDecode() {
        val url = "https://share.example.com/j/AbCdEfGhIjKlMnOpQrStUvWxYz012345"
        val (lum, w, h) = render(Qr.encode(url))
        assertEquals(url, Qr.decode(lum, w, h))
    }

    @Test
    fun invertedCodesAreReadToo() {
        val url = "http://localhost:8080/j/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        val (lum, w, h) = render(Qr.encode(url), invert = true)
        assertEquals(url, Qr.decode(lum, w, h))
    }

    @Test
    fun theCentreMarkLeavesTheCodeReadable() {
        val url = "https://share.example.com/j/AbCdEfGhIjKlMnOpQrStUvWxYz012345"
        val m = Qr.encode(url)
        // Blank the same centre tile the QrCode view draws over (20 % of the width, at least 5 modules).
        val tile = maxOf(5, (m.size * 0.2f).toInt())
        val start = (m.size - tile) / 2
        val bits = BooleanArray(m.size * m.size) { i ->
            val x = i % m.size
            val y = i / m.size
            if (x in start until start + tile && y in start until start + tile) false else m[x, y]
        }
        val (lum, w, h) = render(QrMatrix(m.size, bits))
        assertEquals(url, Qr.decode(lum, w, h))
    }

    @Test
    fun framesWithoutACodeDecodeToNull() {
        assertNull(Qr.decode(ByteArray(200 * 200) { 128.toByte() }, 200, 200))
    }

    @Test
    fun rowStridePaddingIsHonoured() {
        val url = "https://share.example.com/j/AbCdEfGhIjKlMnOpQrStUvWxYz012345"
        val (lum, w, h) = render(Qr.encode(url))
        val stride = w + 16
        val padded = ByteArray(stride * h)
        for (y in 0 until h) System.arraycopy(lum, y * w, padded, y * stride, w)
        assertEquals(url, Qr.decode(padded, w, h, stride))
    }
}
