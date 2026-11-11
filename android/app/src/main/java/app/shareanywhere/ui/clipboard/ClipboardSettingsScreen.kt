package app.shareanywhere.ui.clipboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.ui.components.Choice
import app.shareanywhere.ui.components.ChoiceSheet
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.FlowTopBar
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SettingsRow
import app.shareanywhere.ui.components.SwitchRow
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.SaTokens

/**
 * CB-6 Clipboard settings (`clipboard-settings`, the Web's screen; ST-1 links here): automatic capture on this device,
 * skip sensitive content (with the disclaimer), pause Clipboard Sync, keep items 7/3/1 days, clear history. Account-wide
 * settings apply on every device. A device that is not ready sees them disabled with a link to Clipboard.
 */
@Composable
fun ClipboardSettingsScreen(onBack: () -> Unit, onOpenClipboard: () -> Unit, viewModel: ClipboardViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    var picking by rememberSaveable { mutableStateOf(false) }
    var confirmClear by rememberSaveable { mutableStateOf(false) }
    val settings = ui.snapshot.settings
    val ready = ui.active && settings != null
    Column(Modifier.fillMaxSize().testTag(ScreenIds.CLIPBOARD_SETTINGS)) {
        FlowTopBar(
            stringResource(R.string.product_cb_settings_link),
            R.drawable.ic_arrow_back,
            stringResource(R.string.product_back),
            onBack
        )
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = SaTokens.Space.S4),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
        ) {
            Text(
                stringResource(R.string.product_cb_settings_p_device),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (!ui.active) {
                InlineNotice(NoticeKind.Info, R.drawable.ic_content_paste, stringResource(R.string.product_sign_in_clipboard), action = {
                    TextButton(onClick = onOpenClipboard) { Text(stringResource(R.string.product_cb_back)) }
                })
            } else if (ui.snapshot.settingsError) {
                InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_cb_settings_load_failed), action = {
                    TextButton(onClick = viewModel::retrySettings) { Text(stringResource(R.string.common_retry)) }
                })
            }
            SaCard {
                SwitchRow(
                    label = stringResource(R.string.product_cb_auto_android),
                    description = stringResource(R.string.product_cb_auto_android_p),
                    checked = ui.autoCapture,
                    onCheckedChange = { viewModel.setAutoCapture(it) },
                    modifier = Modifier.testTag("cbs.auto")
                )
            }
            Column(Modifier.then(if (ready) Modifier else Modifier.alpha(0.6f).semantics { disabled() })) {
                SaCard {
                    SwitchRow(
                        label = stringResource(R.string.android_yy_s_skip),
                        description =
                        stringResource(R.string.android_yy_s_skip_p) + "\n" + stringResource(R.string.product_cb_skip_disclaimer),
                        checked = settings?.sensitiveSkip ?: true,
                        onCheckedChange = { on -> if (settings != null) viewModel.saveSettings(settings.copy(sensitiveSkip = on)) },
                        modifier = Modifier.testTag("cbs.skip")
                    )
                    RowDivider()
                    SwitchRow(
                        label = stringResource(R.string.product_cb_pause_label),
                        description = stringResource(R.string.product_cb_pause_p),
                        checked = settings?.paused ?: false,
                        onCheckedChange = { on -> if (settings != null) viewModel.saveSettings(settings.copy(paused = on)) },
                        modifier = Modifier.testTag("cbs.pause")
                    )
                    RowDivider()
                    SettingsRow(
                        stringResource(R.string.android_yy_s_clipkeep),
                        value = settings?.let { keepLabel(it.retentionDays) },
                        description = stringResource(R.string.product_cb_retention_p),
                        onClick = if (ready) ({ picking = true }) else null,
                        modifier = Modifier.testTag("cbs.keep")
                    )
                    RowDivider()
                    SettingsRow(
                        stringResource(R.string.android_yy_cb_clear),
                        onClick = if (ready) ({ confirmClear = true }) else null,
                        modifier = Modifier.testTag("cbs.clear")
                    )
                }
            }
        }
    }
    if (picking && settings != null) {
        ChoiceSheet(
            title = stringResource(R.string.android_yy_s_clipkeep),
            options = listOf(7, 3, 1).map { Choice(it, keepLabel(it)) },
            selected = settings.retentionDays,
            onSelect = {
                picking = false
                viewModel.saveSettings(settings.copy(retentionDays = it))
            },
            onDismiss = { picking = false }
        )
    }
    if (confirmClear) {
        ConfirmDialog(
            stringResource(
                R.string.android_yy_cbc_h
            ),
            stringResource(R.string.android_yy_cbc_p),
            stringResource(R.string.android_yy_cb_clear),
            onConfirm = {
                confirmClear = false
                viewModel.clear()
            },
            onDismiss = { confirmClear = false }
        )
    }
}

@Composable
private fun keepLabel(days: Int) = if (days ==
    1
) {
    stringResource(R.string.product_cb_keep_1)
} else {
    str(R.string.product_cb_keep_days, "n" to days)
}
