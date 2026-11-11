package app.shareanywhere.ui.devices

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.data.api.AccountDevice
import app.shareanywhere.qr.QrScanner
import app.shareanywhere.ui.account.AccountError
import app.shareanywhere.ui.account.AccountViewModel
import app.shareanywhere.ui.account.SendKeyState
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.history.whenText
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens
import java.time.Instant
import kotlinx.coroutines.launch

class DeviceAccountActions(val signIn: () -> Unit, val create: () -> Unit, val addDevice: () -> Unit)

/** DV-1 for guests: the "Sync your device list" intro (design `dv_sync_h`) with Sign in / Create account. */
@Composable
fun DevicesSignInIntro(actions: DeviceAccountActions) {
    SaCard(Modifier.testTag("devices.intro")) {
        Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Text(stringResource(R.string.android_yy_dv_sync_h), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.android_yy_dv_sync_p),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            PrimaryButton(
                stringResource(R.string.android_yy_signin),
                onClick = actions.signIn,
                modifier = Modifier.testTag("devices.signin")
            )
            OutlinedButton(onClick = actions.create, modifier = Modifier.fillMaxWidth().testTag("devices.create")) {
                Text(stringResource(R.string.android_yy_create))
            }
        }
    }
}

/**
 * DV-1 signed in: the account's devices (current first, "This device", platform, last activity, Not paired yet). An added
 * device renames any device and, holding the key, revokes others (DV-2) and pairs new ones; a device not added sees the
 * list read-only with Add this device.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AccountDevicesList(actions: DeviceAccountActions, viewModel: AccountViewModel = hiltViewModel()) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val devices by viewModel.devices.collectAsStateWithLifecycle()
    val failed by viewModel.devicesError.collectAsStateWithLifecycle()
    var renaming by rememberSaveable { mutableStateOf<String?>(null) }
    var revoking by rememberSaveable { mutableStateOf<String?>(null) }
    var pairing by rememberSaveable { mutableStateOf(false) }
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(s.added, s.keyVersion) { viewModel.loadDevices() }
    val ready = s.added && s.keys == KeyStatus.Ready
    Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
        Text(
            stringResource(R.string.android_yy_dv_p),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (!s.added) {
            InlineNotice(
                NoticeKind.Info,
                R.drawable.ic_info,
                stringResource(
                    R.string.product_add_device
                ),
                body = stringResource(R.string.product_not_added_p_device),
                action = {
                    Button(onClick = actions.addDevice, modifier = Modifier.testTag("devices.add-device")) {
                        Text(stringResource(R.string.product_add_device_btn))
                    }
                }
            )
        }
        if (s.rotationOwed && ready) {
            InlineNotice(NoticeKind.Warning, R.drawable.ic_key, stringResource(R.string.product_keys_refused))
        }
        val list = devices
        when {
            list == null && failed ->
                InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_devices_error), action = {
                    TextButton(onClick = { viewModel.loadDevices() }) { Text(stringResource(R.string.common_retry)) }
                })
            list == null -> SkeletonList(3, stringResource(R.string.product_devices_loading))
            else ->
                SaCard(Modifier.testTag("devices.account")) {
                    list.forEachIndexed { i, d ->
                        if (i > 0) RowDivider()
                        DeviceRow(d, canRename = s.added, canRevoke = ready && !d.current, onRename = { renaming = d.id }, onRevoke = {
                            revoking =
                                d.id
                        })
                    }
                }
        }
        if (ready) {
            PrimaryButton(stringResource(R.string.product_pair_device), icon = R.drawable.ic_qr_code_scanner, onClick = {
                viewModel.resetSendKey()
                pairing = true
            }, modifier = Modifier.testTag("devices.pair"))
        } else if (s.added && s.keys != KeyStatus.Ready) {
            Text(
                stringResource(R.string.product_pair_need_key),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
    devices?.firstOrNull { it.id == renaming }?.let { d ->
        RenameAccountDevice(d, viewModel, onDismiss = { renaming = null }, onDone = {
            renaming = null
            scope.launch { snackbar.showSnackbar(context.getString(R.string.android_yy_n_renamed)) }
        })
    }
    devices?.firstOrNull { it.id == revoking }?.let { d ->
        RevokeDialog(d, viewModel, onDismiss = { revoking = null }, onDone = {
            revoking = null
            scope.launch { snackbar.showSnackbar(context.str(R.string.product_revoke_done, "name" to d.name)) }
        })
    }
    if (pairing) PairDeviceSheet(viewModel, onDismiss = { pairing = false })
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DeviceRow(d: AccountDevice, canRename: Boolean, canRevoke: Boolean, onRename: () -> Unit, onRevoke: () -> Unit) {
    val p = LocalSaPalette.current
    val seen = runCatching { Instant.parse(d.lastSeenAt).toEpochMilli() }.getOrNull()
    val now = System.currentTimeMillis()
    Column(
        Modifier.fillMaxWidth().heightIn(
            min = 56.dpx()
        ).padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S3).testTag("device-row")
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            val icon = if (d.platform.contains("Android", true) ||
                d.platform.contains("iOS", true)
            ) {
                R.drawable.ic_smartphone
            } else {
                R.drawable.ic_laptop_windows
            }
            Icon(painterResource(icon), contentDescription = null)
            Column(Modifier.weight(1f)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2), verticalArrangement = Arrangement.Center) {
                    Text(d.name, style = MaterialTheme.typography.titleSmall)
                    if (d.current) {
                        Text(
                            stringResource(R.string.android_yy_dv_this),
                            style = MaterialTheme.typography.labelSmall,
                            color = p.sendInk,
                            modifier = Modifier.clip(CircleShape).padding(horizontal = SaTokens.Space.S1)
                        )
                    }
                }
                val sub = buildList {
                    add(d.platform)
                    if (seen != null) add(str(R.string.product_device_last_seen, "when" to whenText(seen, now)))
                    if (d.added && !d.hasKey) add(stringResource(R.string.product_device_no_key))
                }.joinToString(" · ")
                Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (canRename || canRevoke) {
            Row(Modifier.padding(start = SaTokens.Space.S8)) {
                if (canRename) {
                    TextButton(onClick = onRename, modifier = Modifier.testTag("device.rename")) {
                        Text(stringResource(R.string.android_yy_rename))
                    }
                }
                if (canRevoke) {
                    TextButton(onClick = onRevoke, modifier = Modifier.testTag("device.revoke")) {
                        Text(stringResource(R.string.android_yy_revoke), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

private fun Int.dpx() = androidx.compose.ui.unit.Dp(toFloat())

@Composable
private fun RenameAccountDevice(d: AccountDevice, viewModel: AccountViewModel, onDismiss: () -> Unit, onDone: () -> Unit) {
    var value by rememberSaveable(d.id) { mutableStateOf(d.name) }
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val valid = validDisplayName(value)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.android_xx_rn_h)) },
        text = {
            Column {
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text(stringResource(R.string.android_yy_name)) },
                    singleLine = true,
                    isError = !valid,
                    supportingText = { if (!valid) Text(stringResource(R.string.product_name_invalid)) },
                    modifier = Modifier.fillMaxWidth().testTag("device.rename.field")
                )
                AccountError(error)
            }
        },
        confirmButton = {
            TextButton(enabled = valid && !busy, onClick = {
                viewModel.renameDevice(d.id, value, onDone)
            }, modifier = Modifier.testTag("device.rename.save")) {
                Text(stringResource(R.string.android_xx_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.android_cancel)) } }
    )
}

/** DV-2 Revoke confirmation: what the device loses, key rotation, file sharing keeps working as a guest. */
@Composable
private fun RevokeDialog(d: AccountDevice, viewModel: AccountViewModel, onDismiss: () -> Unit, onDone: () -> Unit) {
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(str(R.string.product_revoke_named_h, "name" to d.name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                Text("• " + stringResource(R.string.product_revoke_history))
                Text("• " + stringResource(R.string.product_revoke_files))
                AccountError(error?.let { app.shareanywhere.ui.account.UiText(R.string.product_revoke_failed) })
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                viewModel.revokeDevice(d.id, onDone)
            }, modifier = Modifier.testTag("device.revoke.confirm")) {
                Text(stringResource(R.string.android_xx_rv_yes), color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.android_cancel)) } }
    )
}

/**
 * Pair a new device: paste the new device's `sa1.…` code or scan its QR (CameraX), confirm its name, send the key. Works
 * with a Web device as the new one (its AC-6 shows the QR).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairDeviceSheet(viewModel: AccountViewModel, onDismiss: () -> Unit) {
    val state by viewModel.sendKey.collectAsStateWithLifecycle()
    var code by remember { mutableStateOf("") }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var cameraDenied by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            scanning = granted
            cameraDenied = !granted
        }
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("pair-device")) {
        Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Text(stringResource(R.string.product_pair_device), style = MaterialTheme.typography.titleLarge)
            when (val st = state) {
                is SendKeyState.Confirm -> {
                    Text(
                        str(R.string.product_pair_confirm, "name" to st.found.peer.deviceName),
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(stringResource(R.string.product_pair_confirm_p))
                    PrimaryButton(stringResource(R.string.product_pair_send), onClick = {
                        viewModel.confirmSend(st.found)
                    }, modifier = Modifier.testTag("pair-device.send"))
                    TextButton(onClick = viewModel::resetSendKey) { Text(stringResource(R.string.android_cancel)) }
                }
                SendKeyState.Sending -> PrimaryButton(stringResource(R.string.product_pair_send), onClick = {}, busy = true)
                is SendKeyState.Sent -> {
                    InlineNotice(
                        NoticeKind.Info,
                        R.drawable.ic_check_circle,
                        str(R.string.product_pair_sent, "name" to st.name),
                        Modifier.testTag("pair-device.sent")
                    )
                    PrimaryButton(stringResource(R.string.android_done_h), onClick = onDismiss)
                }
                else -> {
                    Text(stringResource(R.string.product_pair_device_p))
                    if (scanning) {
                        Text(stringResource(R.string.product_pair_scan_p), style = MaterialTheme.typography.bodySmall)
                        QrScanner(
                            active = true,
                            torch = false,
                            onResult = {
                                scanning = false
                                code = it
                                viewModel.findCode(it)
                            },
                            onUnavailable = {
                                scanning = false
                                cameraDenied = true
                            },
                            modifier = Modifier.fillMaxWidth().aspectRatio(
                                1f
                            ).clip(androidx.compose.foundation.shape.RoundedCornerShape(SaTokens.Radius.Lg))
                                .semantics { contentDescription = context.getString(R.string.product_pair_scan_video) }
                        )
                        OutlinedButton(onClick = { scanning = false }) { Text(stringResource(R.string.product_pair_scan_stop)) }
                    } else {
                        OutlinedButton(onClick = {
                            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                                PackageManager.PERMISSION_GRANTED
                            ) {
                                scanning = true
                            } else {
                                permission.launch(Manifest.permission.CAMERA)
                            }
                        }, modifier = Modifier.testTag("pair-device.scan")) {
                            Icon(
                                painterResource(R.drawable.ic_qr_code_scanner),
                                contentDescription = null,
                                modifier = Modifier.size(SaTokens.Space.S4)
                            )
                            Text("  " + stringResource(R.string.product_pair_scan))
                        }
                    }
                    if (cameraDenied) Text(stringResource(R.string.product_pair_camera_denied), color = MaterialTheme.colorScheme.error)
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it },
                        label = { Text(stringResource(R.string.product_pair_paste_label)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("pair-device.code")
                    )
                    if (st is SendKeyState.Failed) {
                        Text(
                            str(st.message.id, *st.message.args.toList().toTypedArray()),
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.testTag("pair-device.error")
                        )
                    }
                    PrimaryButton(
                        stringResource(R.string.product_pair_find),
                        enabled = code.isNotBlank(),
                        busy = st == SendKeyState.Finding,
                        onClick = { viewModel.findCode(code) },
                        modifier = Modifier.testTag("pair-device.find")
                    )
                }
            }
        }
    }
}
