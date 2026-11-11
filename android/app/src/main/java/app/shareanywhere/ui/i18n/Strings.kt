package app.shareanywhere.ui.i18n

import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.content.res.Resources
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.LayoutDirection
import app.shareanywhere.settings.AppLanguage
import java.util.Locale

private val PLACEHOLDER = Regex("\\{(\\w+)}")

/**
 * Fills catalog placeholders the way the Web's `format()` does (docs/DESIGN_SYSTEM.md §1.2): named `{name}` from
 * [named], positional `{1}`, `{2}` from [positional]. Unknown placeholders stay visible so gaps show in tests.
 */
fun formatTemplate(template: String, named: Map<String, Any> = emptyMap(), positional: List<Any> = emptyList()): String =
    PLACEHOLDER.replace(template) { m ->
        val key = m.groupValues[1]
        val value = key.toIntOrNull()?.let { positional.getOrNull(it - 1) } ?: named[key]
        value?.toString() ?: m.value
    }

/** A catalog string with named placeholders filled. */
@Composable
@ReadOnlyComposable
fun str(@StringRes id: Int, vararg named: Pair<String, Any>): String = formatTemplate(stringResource(id), named.toMap())

/** A `<app>_patterns` string with positional placeholders filled. */
@Composable
@ReadOnlyComposable
fun strP(@StringRes id: Int, vararg positional: Any): String = formatTemplate(stringResource(id), positional = positional.toList())

/** Same as [str] outside composition (view models, notifications). */
fun Context.str(@StringRes id: Int, vararg named: Pair<String, Any>): String = formatTemplate(getString(id), named.toMap())

/** Resources in the chosen language while the Activity stays the context (dialogs, insets, activity results). */
private class LocalizedContext(base: Context, private val localized: Resources) : ContextWrapper(base) {
    override fun getResources(): Resources = localized
}

/** The locale the UI renders in: the chosen app language, else the system's first locale. */
fun Configuration.uiLocale(): Locale = locales[0] ?: Locale.getDefault()

/**
 * Applies the in-app language choice (Settings › Language) to everything below: string resources, the
 * configuration (date and number formatting via [uiLocale]) and layout direction. "System" leaves the
 * Activity's own configuration untouched.
 */
@Composable
fun ProvideAppLanguage(language: AppLanguage, content: @Composable () -> Unit) {
    val base = LocalContext.current
    val baseConfig = LocalConfiguration.current
    val tag = language.tag
    // Always the same composition structure, so switching language keeps navigation and screen state.
    val config =
        remember(baseConfig, tag) {
            if (tag == null) {
                baseConfig
            } else {
                Configuration(baseConfig).apply {
                    val locale = Locale.forLanguageTag(tag)
                    setLocale(locale)
                    setLayoutDirection(locale)
                }
            }
        }
    val context =
        remember(base, config) {
            if (config === baseConfig) base else LocalizedContext(base, base.createConfigurationContext(config).resources)
        }
    val direction = if (config.layoutDirection == android.view.View.LAYOUT_DIRECTION_RTL) LayoutDirection.Rtl else LayoutDirection.Ltr
    CompositionLocalProvider(
        LocalContext provides context,
        LocalConfiguration provides config,
        LocalLayoutDirection provides direction,
        content = content
    )
}
