package app.shareanywhere.qr

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.shareanywhere.ui.theme.SaTokens

/**
 * The join link as a QR code (design `session`: 164 dp, navy modules on white with the logo mark in the centre).
 * Always dark-on-light, also in the dark theme, so every scanner reads it.
 */
@Composable
fun QrCode(value: String, contentDescription: String, modifier: Modifier = Modifier, size: Dp = 164.dp) {
    val matrix = remember(value) { Qr.encode(value) }
    val ink = SaTokens.Light.fg
    val blue = SaTokens.Light.focus
    val green = SaTokens.Light.receive
    Canvas(
        modifier
            .clip(RoundedCornerShape(SaTokens.Radius.Lg))
            .background(SaTokens.Light.surface)
            .padding(SaTokens.Space.S3)
            .size(size)
            .semantics { this.contentDescription = contentDescription }
    ) {
        val cell = this.size.minDimension / matrix.size
        for (y in 0 until matrix.size) {
            for (x in 0 until matrix.size) {
                if (matrix[x, y]) drawRect(ink, Offset(x * cell, y * cell), Size(cell + 0.5f, cell + 0.5f))
            }
        }
        // Centre mark: a white tile with the logo's two bars, inside the 30 % that level H can recover.
        val tile = cell * (matrix.size * 0.2f).coerceAtLeast(5f)
        val o = (this.size.minDimension - tile) / 2
        drawRoundRect(SaTokens.Light.surface, Offset(o, o), Size(tile, tile), CornerRadius(tile * 0.23f))
        val barH = tile * 0.27f
        drawRoundRect(blue, Offset(o + tile * 0.13f, o + tile * 0.18f), Size(tile * 0.6f, barH), CornerRadius(barH / 2))
        drawRoundRect(green, Offset(o + tile * 0.27f, o + tile * 0.55f), Size(tile * 0.6f, barH), CornerRadius(barH / 2))
    }
}
