package app.shareanywhere.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.shareanywhere.R
import app.shareanywhere.ui.theme.LocalSaDark
import app.shareanywhere.ui.theme.SaLogoColors
import app.shareanywhere.ui.theme.SaTokens
import app.shareanywhere.ui.theme.SaTypography

/**
 * The "Passing lanes" mark drawn from tokens.json logo geometry (two capsules with a dot on each leading edge),
 * in the theme's colour mode; dotless at 16 dp and below (DESIGN_DEVIATIONS C3). With [lockup] the wordmark
 * follows at the token ratios.
 */
@Composable
fun Logo(size: Dp, modifier: Modifier = Modifier, lockup: Boolean = false) {
    val colors = if (LocalSaDark.current) SaTokens.Logo.ForDark else SaTokens.Logo.ForLight
    val name = stringResource(R.string.app_name)
    if (!lockup) {
        LogoMark(size, colors, modifier.semantics { contentDescription = name })
        return
    }
    val textSize = with(LocalDensity.current) { (size * SaTokens.Logo.WORDMARK_SIZE_RATIO).toSp() }
    Row(
        modifier = modifier.semantics(mergeDescendants = true) { contentDescription = name },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(size * SaTokens.Logo.WORDMARK_GAP_RATIO)
    ) {
        LogoMark(size, colors, Modifier)
        Text(
            text = name,
            color = colors.text,
            style =
            SaTypography.titleLarge.merge(
                TextStyle(fontSize = textSize, fontWeight = FontWeight(SaTokens.Logo.WORDMARK_WEIGHT))
            ),
            maxLines = 1
        )
    }
}

@Composable
private fun LogoMark(size: Dp, colors: SaLogoColors, modifier: Modifier) {
    val dots = size > SaTokens.Logo.DOTLESS_AT_OR_BELOW_DP.dp
    Canvas(modifier.size(size)) {
        val k = this.size.width / SaTokens.Logo.VIEWBOX
        fun capsule(g: FloatArray, color: androidx.compose.ui.graphics.Color) =
            drawRoundRect(color, Offset(g[0] * k, g[1] * k), Size(g[2] * k, g[3] * k), CornerRadius(g[4] * k, g[4] * k))
        fun dot(g: FloatArray) = drawCircle(colors.dot, g[2] * k, Offset(g[0] * k, g[1] * k))
        capsule(SaTokens.Logo.CapsuleSend, colors.send)
        capsule(SaTokens.Logo.CapsuleReceive, colors.receive)
        if (dots) {
            dot(SaTokens.Logo.DotSend)
            dot(SaTokens.Logo.DotReceive)
        }
    }
}
