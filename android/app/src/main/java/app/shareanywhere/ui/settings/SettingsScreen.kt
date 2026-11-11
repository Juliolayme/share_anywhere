package app.shareanywhere.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.history.Retention
import app.shareanywhere.settings.AppLanguage
import app.shareanywhere.settings.AppSettings
import app.shareanywhere.settings.ThemeMode
import app.shareanywhere.ui.components.Choice
import app.shareanywhere.ui.components.ChoiceSheet
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.ScreenHeader
import app.shareanywhere.ui.components.SectionLabel
import app.shareanywhere.ui.components.SettingsRow
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.components.SwitchRow
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

private enum class Picker { Theme, Language, Retention }

/**
 * ST-1 Settings for guests: Guest header (no Sign in until accounts ship, CLAUDE.md §8b), theme, language,
 * Keep screen on during transfers (default on, this device), local history retention and Clear history,
 * privacy note, version. Transfer strategy, notifications, data and battery, Cloud and Clipboard rows arrive
 * with the features they control (DESIGN_DEVIATIONS F6).
 */
@Composable
fun SettingsScreen(viewModel: SettingsViewModel = hiltViewModel()) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val hasHistory by viewModel.hasHistory.collectAsStateWithLifecycle()
    val event by viewModel.events.collectAsStateWithLifecycle()
    var picker by rememberSaveable { mutableStateOf<Picker?>(null) }
    var confirmClear by rememberSaveable { mutableStateOf(false) }
    val snackbar = LocalSnackbar.current
    val cleared = stringResource(R.string.android_yy_n_cleared)
    val clearFailed = stringResource(R.string.product_clear_failed)
    LaunchedEffect(event) {
        when (event) {
            SettingsEvent.Cleared -> snackbar.showSnackbar(cleared)
            SettingsEvent.ClearFailed -> snackbar.showSnackbar(clearFailed)
            null -> return@LaunchedEffect
        }
        viewModel.eventShown()
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag(ScreenIds.SETTINGS),
        contentPadding = PaddingValues(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2)
    ) {
        item { ScreenHeader(stringResource(R.string.android_set)) }
        val current = s
        if (current == null) {
            item { SkeletonList(4, stringResource(R.string.android_set)) }
        } else {
            settingsItems(current, hasHistory, viewModel, onPick = { picker = it }, onClear = { confirmClear = true })
        }
    }

    val current = s ?: return
    when (picker) {
        Picker.Theme ->
            ChoiceSheet(
                title = stringResource(R.string.android_yy_s_theme),
                options = themeChoices(),
                selected = current.theme,
                onSelect = {
                    viewModel.setTheme(it)
                    picker = null
                },
                onDismiss = { picker = null }
            )
        Picker.Language ->
            ChoiceSheet(
                title = stringResource(R.string.android_yy_s_lang),
                options = languageChoices(),
                selected = current.language,
                onSelect = {
                    viewModel.setLanguage(it)
                    picker = null
                },
                onDismiss = { picker = null }
            )
        Picker.Retention ->
            ChoiceSheet(
                title = stringResource(R.string.android_yy_s_histkeep),
                options = retentionChoices(),
                selected = current.retention,
                onSelect = {
                    viewModel.setRetention(it)
                    picker = null
                },
                onDismiss = { picker = null }
            )
        null -> Unit
    }
    if (confirmClear) {
        ConfirmDialog(
            title = stringResource(R.string.android_yy_hc_h),
            body = stringResource(R.string.android_yy_hc_p),
            confirm = stringResource(R.string.android_yy_cb_clear),
            onConfirm = {
                confirmClear = false
                viewModel.clearHistory()
            },
            onDismiss = { confirmClear = false }
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.settingsItems(
    s: AppSettings,
    hasHistory: Boolean,
    viewModel: SettingsViewModel,
    onPick: (Picker) -> Unit,
    onClear: () -> Unit
) {
    item { SectionLabel(stringResource(R.string.android_yy_g_account)) }
    item { GuestHeader() }
    item { SectionLabel(stringResource(R.string.android_yy_g_app)) }
    item {
        SaCard {
            SettingsRow(
                stringResource(R.string.android_yy_s_theme),
                value = themeChoices().first { it.value == s.theme }.label,
                onClick = { onPick(Picker.Theme) },
                modifier = Modifier.testTag("settings.theme")
            )
            RowDivider()
            SettingsRow(
                stringResource(R.string.android_yy_s_lang),
                value = languageChoices().first { it.value == s.language }.label,
                onClick = { onPick(Picker.Language) },
                modifier = Modifier.testTag("settings.language")
            )
        }
    }
    item { SectionLabel(stringResource(R.string.android_yy_g_transfer)) }
    item {
        SaCard {
            SwitchRow(
                label = stringResource(R.string.android_yy_s_wake),
                description = stringResource(R.string.android_yy_s_wake_p),
                checked = s.keepScreenOn,
                onCheckedChange = viewModel::setKeepScreenOn,
                modifier = Modifier.testTag("settings.keep_screen_on")
            )
        }
    }
    item { SectionLabel(stringResource(R.string.android_yy_g_priv)) }
    item {
        SaCard {
            SettingsRow(
                stringResource(R.string.android_yy_s_histkeep),
                value = retentionChoices().first { it.value == s.retention }.label,
                onClick = { onPick(Picker.Retention) },
                modifier = Modifier.testTag("settings.retention")
            )
            if (hasHistory) {
                RowDivider()
                SettingsRow(
                    stringResource(R.string.android_yy_cb_clear),
                    onClick = onClear,
                    modifier = Modifier.testTag("settings.clear_history")
                )
            }
            Text(
                stringResource(R.string.android_yy_s_priv_p),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(SaTokens.Space.S4)
            )
        }
    }
    item { SectionLabel(stringResource(R.string.android_yy_g_about)) }
    item {
        SaCard {
            SettingsRow(
                stringResource(R.string.android_yy_s_version),
                value = "${viewModel.config.versionName} (${viewModel.config.versionCode})",
                modifier = Modifier.testTag("settings.version")
            )
        }
    }
}

@Composable
private fun GuestHeader() {
    val p = LocalSaPalette.current
    SaCard(Modifier.testTag("settings.guest")) {
        Row(
            Modifier.padding(SaTokens.Space.S4),
            horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier.size(SaTokens.Space.S8 + SaTokens.Space.S2).clip(CircleShape).background(p.surface2),
                contentAlignment = Alignment.Center
            ) { Icon(painterResource(R.drawable.ic_person), contentDescription = null, tint = p.fg2) }
            Column {
                Text(stringResource(R.string.android_yy_s_guest), style = MaterialTheme.typography.titleMedium)
                Text(
                    stringResource(R.string.product_no_account),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun themeChoices() = listOf(
    Choice(ThemeMode.SYSTEM, stringResource(R.string.android_yy_th_sys)),
    Choice(ThemeMode.LIGHT, stringResource(R.string.android_yy_th_light)),
    Choice(ThemeMode.DARK, stringResource(R.string.android_yy_th_dark))
)

@Composable
private fun languageChoices() = listOf(
    Choice(AppLanguage.SYSTEM, stringResource(R.string.android_yy_th_sys)),
    Choice(AppLanguage.EN, stringResource(R.string.product_lang_en)),
    Choice(AppLanguage.VI, stringResource(R.string.product_lang_vi))
)

@Composable
private fun retentionChoices() = listOf(
    Choice(Retention.DAYS_30, stringResource(R.string.android_yy_h30)),
    Choice(Retention.DAYS_90, stringResource(R.string.android_yy_h90)),
    Choice(Retention.NONE, stringResource(R.string.android_yy_h0))
)
