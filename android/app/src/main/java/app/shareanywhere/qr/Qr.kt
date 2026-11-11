package app.shareanywhere.qr

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** QR modules for [text]: `modules[y][x]` is true for a dark module. No quiet zone (the view adds it). */
class QrMatrix(val size: Int, private val bits: BooleanArray) {
    operator fun get(x: Int, y: Int): Boolean = bits[y * size + x]
}

/**
 * QR encode and decode with ZXing core (pure Java, no Play services; docs/ADR/0019-android-qr.md). The share
 * panel encodes the join link at error-correction level H so the centre mark (design `session`) never hides data.
 */
object Qr {
    fun encode(text: String, level: ErrorCorrectionLevel = ErrorCorrectionLevel.H): QrMatrix {
        val hints = mapOf(EncodeHintType.ERROR_CORRECTION to level, EncodeHintType.MARGIN to 0, EncodeHintType.CHARACTER_SET to "UTF-8")
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
        val n = m.width
        val bits = BooleanArray(n * n) { i -> m.get(i % n, i / n) }
        return QrMatrix(n, bits)
    }

    private val decodeHints =
        mapOf(
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER to true,
            DecodeHintType.CHARACTER_SET to "UTF-8"
        )

    /**
     * Decodes a QR code from a luminance (Y) plane, as delivered by CameraX ImageAnalysis. Returns null when no
     * code is found; never throws for unreadable frames.
     */
    fun decode(luminance: ByteArray, width: Int, height: Int, rowStride: Int = width): String? {
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
        val reader = QRCodeReader()
        for (candidate in listOf(source, source.invert())) {
            try {
                return reader.decode(BinaryBitmap(HybridBinarizer(candidate)), decodeHints).text
            } catch (_: NotFoundException) {
                reader.reset()
            } catch (_: ReaderException) {
                reader.reset()
            }
        }
        return null
    }
}
