package app.shareanywhere.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.data.api.Device
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.ScreenHeader
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.format.formatCountdown
import app.shareanywhere.ui.format.formatDate
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.identity.IdentityNotice
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens
import java.time.Instant

/**
 * DV-1 Devices for guests: the "This device" card with Rename and Reset device identity. The account device
 * list and its sign-in intro arrive with accounts (milestone 6.4, CLAUDE.md §8b).
 */
@Composable
fun DevicesScreen(viewModel: DevicesViewModel = hiltViewModel()) {
    val identity by viewModel.identityState.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val result by viewModel.result.collectAsStateWithLifecycle()
    var renaming by rememberSaveable { mutableStateOf(false) }
    var confirmReset by rememberSaveable { mutableStateOf(false) }
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current

    LaunchedEffect(result) {
        val r = result ?: return@LaunchedEffect
        if (r == DeviceActionResult.Renamed) renaming = false
        // Rename errors show inside the dialog while it is open; everything else is a snackbar.
        if (renaming && r != DeviceActionResult.Renamed) return@LaunchedEffect
        snackbar.showSnackbar(context.resultMessage(r))
        viewModel.resultShown()
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag(ScreenIds.DEVICES),
        contentPadding = PaddingValues(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        item { ScreenHeader(stringResource(R.string.android_dev)) }
        item { IdentityNotice(identity, onRetry = viewModel::retryIdentity, onDismissReplaced = viewModel::dismissReplaced) }
        item {
            val device = identity.device
            if (device == null) {
                SkeletonList(1, stringResource(R.string.product_identity_loading))
            } else {
                ThisDeviceCard(device, busy, onRename = { renaming = true }, onReset = { confirmReset = true })
            }
        }
    }

    val device = identity.device
    if (renaming && device != null) {
        RenameDialog(
            current = device.displayName,
            busy = busy,
            error = result?.takeIf { it != DeviceActionResult.Renamed }?.let { context.resultMessage(it) },
            onSave = viewModel::rename,
            onDismiss = {
                renaming = false
                viewModel.resultShown()
            }
        )
    }
    if (confirmReset) {
        ConfirmDialog(
            title = stringResource(R.string.product_reset_identity),
            body = stringResource(R.string.product_reset_identity_p),
            confirm = stringResource(R.string.product_reset_identity),
            onConfirm = {
                confirmReset = false
                viewModel.reset()
            },
            onDismiss = { confirmReset = false }
        )
    }
}

private fun android.content.Context.resultMessage(r: DeviceActionResult): String = when (r) {
    DeviceActionResult.Renamed -> getString(R.string.android_yy_n_renamed)
    DeviceActionResult.Reset -> getString(R.string.product_reset_done)
    DeviceActionResult.Offline -> getString(R.string.product_acct_offline)
    is DeviceActionResult.RateLimited -> str(R.string.product_rate_limited, "time" to formatCountdown(r.seconds.toLong()))
    DeviceActionResult.RenameFailed -> getString(R.string.product_rename_failed)
    DeviceActionResult.ResetFailed -> getString(R.string.product_error_generic)
}

@Composable
private fun ThisDeviceCard(device: Device, busy: Boolean, onRename: () -> Unit, onReset: () -> Unit) {
    val p = LocalSaPalette.current
    val locale = LocalConfiguration.current.uiLocale()
    val since = runCatching { formatDate(Instant.parse(device.createdAt).toEpochMilli(), locale) }.getOrNull()
    SaCard(Modifier.testTag("devices.this")) {
        Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(SaTokens.Space.S8 + SaTokens.Space.S2)
                        .clip(RoundedCornerShape(SaTokens.Radius.Md))
                        .background(p.sendSoft),
                    contentAlignment = Alignment.Center
                ) { Icon(painterResource(R.drawable.ic_smartphone), contentDescription = null, tint = p.sendInk) }
                Column(Modifier.weight(1f)) {
                    Text(device.displayName, style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("devices.name"))
                    Text(device.platform, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (since != null) {
                        Text(
                            str(R.string.product_anon_since, "date" to since),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Text(
                    stringResource(R.string.android_yy_dv_this),
                    style = MaterialTheme.typography.labelMedium,
                    color = p.sendInk,
                    modifier =
                    Modifier
                        .clip(CircleShape)
                        .background(p.sendSoft)
                        .padding(horizontal = SaTokens.Space.S2, vertical = SaTokens.Space.S1)
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                OutlinedButton(onClick = onRename, enabled = !busy, modifier = Modifier.testTag("devices.rename")) {
                    Text(stringResource(R.string.android_yy_rename))
                }
                OutlinedButton(onClick = onReset, enabled = !busy, modifier = Modifier.testTag("devices.reset")) {
                    Text(stringResource(R.string.product_reset_identity), color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun RenameDialog(current: String, busy: Boolean, error: String?, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var value by rememberSaveable { mutableStateOf(current) }
    val valid = validDisplayName(value)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.android_xx_rn_h)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text(stringResource(R.string.android_yy_name)) },
                    singleLine = true,
                    isError = !valid || error != null,
                    supportingText = {
                        when {
                            !valid -> Text(stringResource(R.string.product_name_invalid))
                            error != null -> Text(error)
                        }
                    },
                    modifier = Modifier.fillMaxWidth().testTag("devices.rename.field")
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(value) }, enabled = valid && !busy, modifier = Modifier.testTag("devices.rename.save")) {
                Text(stringResource(R.string.android_yy_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.android_yy_cancel)) } }
    )
}
