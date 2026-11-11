package app.shareanywhere.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import app.shareanywhere.R

/** Plus Jakarta Sans (the design's sans family, variable weight, OFL); mono uses the platform monospace. */
@OptIn(ExperimentalTextApi::class)
private val Sans =
    FontFamily(
        listOf(400, 500, 600, 700, 800).map { w ->
            Font(
                R.font.plus_jakarta_sans,
                weight = FontWeight(w),
                variationSettings = FontVariation.Settings(FontVariation.weight(w))
            )
        }
    )

/** Extra design roles Material 3 has no slot for (soft/ink variants, warning, track, focus). */
val LocalSaPalette = staticCompositionLocalOf { SaTokens.Light }

/** True when the dark palette is in use (the logo switches to its dark mode). */
val LocalSaDark = staticCompositionLocalOf { false }

private fun scheme(p: SaPalette, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = p.send,
        onPrimary = p.onSend,
        primaryContainer = p.sendSoft,
        onPrimaryContainer = p.sendInk,
        inversePrimary = p.sendInk,
        secondary = p.receive,
        onSecondary = p.onReceive,
        secondaryContainer = p.receiveSoft,
        onSecondaryContainer = p.receiveInk,
        tertiary = p.cloudInk,
        onTertiary = p.surface,
        tertiaryContainer = p.cloudSoft,
        onTertiaryContainer = p.cloudInk,
        background = p.bg,
        onBackground = p.fg,
        surface = p.surface,
        onSurface = p.fg,
        surfaceVariant = p.surface2,
        onSurfaceVariant = p.fg2,
        surfaceTint = p.send,
        inverseSurface = p.toast,
        inverseOnSurface = p.toastFg,
        error = p.danger,
        onError = p.surface,
        errorContainer = p.dangerSoft,
        onErrorContainer = p.dangerInk,
        outline = p.borderStrong,
        outlineVariant = p.border,
        scrim = p.scrim,
        surfaceBright = p.surface,
        surfaceDim = p.surface2,
        surfaceContainerLowest = p.surface,
        surfaceContainerLow = p.surface,
        surfaceContainer = p.surface,
        surfaceContainerHigh = p.surface2,
        surfaceContainerHighest = p.surface2
    )
}

private fun style(t: SaTypeStyle) = TextStyle(
    fontFamily = if (t.mono) FontFamily.Monospace else Sans,
    fontWeight = t.weight,
    fontSize = t.size,
    lineHeight = t.line
)

/** Material 3 type roles mapped onto the token type scale (docs/DESIGN_SYSTEM.md §2). */
val SaTypography: Typography =
    Typography(
        displayLarge = style(SaTokens.Type.Display),
        displayMedium = style(SaTokens.Type.Display),
        displaySmall = style(SaTokens.Type.Display),
        headlineLarge = style(SaTokens.Type.Headline),
        headlineMedium = style(SaTokens.Type.Headline),
        headlineSmall = style(SaTokens.Type.Headline),
        titleLarge = style(SaTokens.Type.Title),
        titleMedium = style(SaTokens.Type.LabelLg),
        titleSmall = style(SaTokens.Type.Caption).copy(fontWeight = SaTokens.Weight.Semibold),
        bodyLarge = style(SaTokens.Type.Body),
        bodyMedium = style(SaTokens.Type.Body),
        bodySmall = style(SaTokens.Type.Caption).copy(fontWeight = SaTokens.Weight.Regular),
        labelLarge = style(SaTokens.Type.LabelLg),
        labelMedium = style(SaTokens.Type.Caption),
        labelSmall = style(SaTokens.Type.Caption)
    )

/** Monospace style for codes and byte counts (type "code" family at caption size). */
val SaMonoCaption: TextStyle = style(SaTokens.Type.Caption).copy(fontFamily = FontFamily.Monospace)

private val SaShapes =
    Shapes(
        extraSmall = RoundedCornerShape(SaTokens.Radius.Sm),
        small = RoundedCornerShape(SaTokens.Radius.Md),
        medium = RoundedCornerShape(SaTokens.Radius.Lg),
        large = RoundedCornerShape(SaTokens.Radius.Xl),
        extraLarge = RoundedCornerShape(SaTokens.Radius.Xl)
    )

@Composable
fun ShareAnywhereTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val palette = if (dark) SaTokens.Dark else SaTokens.Light
    CompositionLocalProvider(LocalSaPalette provides palette, LocalSaDark provides dark) {
        MaterialTheme(colorScheme = scheme(palette, dark), typography = SaTypography, shapes = SaShapes, content = content)
    }
}
