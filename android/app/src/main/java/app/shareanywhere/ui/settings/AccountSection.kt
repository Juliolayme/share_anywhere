package app.shareanywhere.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.account.AccountState
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.ui.account.AccountError
import app.shareanywhere.ui.account.AccountViewModel
import app.shareanywhere.ui.account.PasswordField
import app.shareanywhere.ui.account.SignOutDialog
import app.shareanywhere.ui.account.passwordProblem
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SectionLabel
import app.shareanywhere.ui.components.SettingsRow
import app.shareanywhere.ui.components.SwitchRow
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens
import kotlinx.coroutines.launch

/** Where the account rows lead (account graph, Devices, Clipboard settings). */
class AccountActions(
    val signIn: () -> Unit,
    val create: () -> Unit,
    val addDevice: () -> Unit,
    val setUpKeys: () -> Unit,
    val pair: () -> Unit,
    val phrase: () -> Unit,
    val manageDevices: () -> Unit,
    val clipboardSettings: (() -> Unit)?
)

/**
 * ST-1 Account section (docs/UX_SCREEN_MAP.md §8 "As built"): guests get the Guest header with Sign in / Create account and
 * the account rows disabled; signed in shows the account, Add this device while not added, Sync transfer history, the
 * key state with its action, Manage devices, Cloud (disabled until Phase 8), Change password and Sign out.
 */
@Composable
fun AccountSection(actions: AccountActions, viewModel: AccountViewModel = hiltViewModel()) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    var signingOut by rememberSaveable { mutableStateOf(false) }
    var changingPassword by rememberSaveable { mutableStateOf(false) }
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
        if (!s.signedIn) {
            GuestAccount(actions)
        } else {
            SignedInAccount(s, actions, viewModel, onChangePassword = { changingPassword = true }, onSignOut = {
                signingOut =
                    true
            })
        }
        if (actions.clipboardSettings != null) {
            SectionLabel(stringResource(R.string.android_yy_g_clip))
            SaCard {
                if (s.signedIn) {
                    SettingsRow(
                        stringResource(R.string.product_cb_settings_link),
                        onClick = actions.clipboardSettings,
                        modifier = Modifier.testTag("settings.clipboard")
                    )
                } else {
                    DisabledRow(stringResource(R.string.product_cb_settings_link), stringResource(R.string.android_yy_s_guest_p))
                }
            }
        }
    }
    if (signingOut) {
        SignOutDialog(onDismiss = { signingOut = false }, onSignedOut = {
            signingOut = false
            scope.launch { snackbar.showSnackbar(context.getString(R.string.product_signed_out_device)) }
        })
    }
    if (changingPassword) {
        ChangePasswordDialog(viewModel, onDismiss = { changingPassword = false }, onDone = {
            changingPassword = false
            scope.launch { snackbar.showSnackbar(context.getString(R.string.common_cp_done)) }
        })
    }
}

@Composable
private fun Avatar(initial: String?, filled: Boolean) {
    val p = LocalSaPalette.current
    Box(
        Modifier.size(SaTokens.Space.S8 + SaTokens.Space.S2).clip(CircleShape).background(if (filled) p.send else p.surface2),
        contentAlignment = Alignment.Center
    ) {
        if (initial != null) {
            Text(initial, color = p.onSend, style = MaterialTheme.typography.titleMedium)
        } else {
            Icon(painterResource(R.drawable.ic_person), contentDescription = null, tint = p.fg2)
        }
    }
}

@Composable
private fun GuestAccount(actions: AccountActions) {
    SaCard(Modifier.testTag("settings.guest")) {
        Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3), verticalAlignment = Alignment.CenterVertically) {
                Avatar(null, false)
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.android_yy_s_guest), style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(R.string.android_yy_s_guest_p),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Button(onClick = actions.signIn, modifier = Modifier.testTag("settings.signin")) {
                    Text(stringResource(R.string.android_yy_signin))
                }
            }
            Text(
                stringResource(R.string.product_account_guest_p),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedButton(onClick = actions.create, modifier = Modifier.testTag("settings.create")) {
                Text(stringResource(R.string.android_yy_create))
            }
        }
    }
    SaCard {
        DisabledRow(stringResource(R.string.product_history_sync), stringResource(R.string.android_yy_s_guest_p))
        RowDivider()
        DisabledRow(stringResource(R.string.product_manage_devices), stringResource(R.string.android_yy_s_guest_p))
        RowDivider()
        DisabledRow(stringResource(R.string.common_s_cloud), stringResource(R.string.android_yy_s_guest_p))
    }
}

@Composable
private fun DisabledRow(label: String, description: String) {
    Box(Modifier.alpha(0.6f).semantics { disabled() }) { SettingsRow(label, description = description) }
}

@Composable
private fun SignedInAccount(
    s: AccountState,
    actions: AccountActions,
    viewModel: AccountViewModel,
    onChangePassword: () -> Unit,
    onSignOut: () -> Unit
) {
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    SaCard(Modifier.testTag("settings.account")) {
        Row(
            Modifier.padding(SaTokens.Space.S4),
            horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Avatar(s.email?.firstOrNull()?.uppercase() ?: "?", true)
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.product_badge_signed_in), style = MaterialTheme.typography.titleMedium)
                Text(
                    s.email.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("settings.email")
                )
            }
        }
        if (s.meFailed) {
            RowDivider()
            SettingsRow(stringResource(R.string.product_account_load_failed), value = stringResource(R.string.common_retry), onClick = {
                viewModel.retryMe()
            })
        }
        RowDivider()
        if (!s.added) {
            Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                Text(stringResource(R.string.product_add_device_clipboard), style = MaterialTheme.typography.bodyLarge)
                Text(
                    stringResource(R.string.product_not_added_p_device),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Button(onClick = actions.addDevice, modifier = Modifier.testTag("settings.add-device")) {
                    Text(stringResource(R.string.product_add_device_btn))
                }
            }
        } else {
            if (s.keys == KeyStatus.Ready) {
                SwitchRow(
                    label = stringResource(R.string.product_history_sync),
                    description = stringResource(R.string.product_history_sync_p),
                    checked = s.historySync,
                    onCheckedChange = { if (!busy) viewModel.setHistorySync(it) },
                    modifier = Modifier.testTag("settings.history-sync")
                )
            } else {
                SettingsRow(
                    stringResource(R.string.product_history_sync),
                    description = stringResource(R.string.product_history_sync_needs_key)
                )
            }
            AccountError(error?.takeIf { true })
            RowDivider()
            KeyRow(s.keys, actions, onRetry = { viewModel.retryKeys() })
        }
        RowDivider()
        SettingsRow(
            stringResource(R.string.product_manage_devices),
            onClick = actions.manageDevices,
            modifier = Modifier.testTag("settings.devices")
        )
        RowDivider()
        DisabledRow(stringResource(R.string.common_s_cloud), stringResource(R.string.product_cloud_later))
        RowDivider()
        SettingsRow(stringResource(R.string.android_yy_s_chpw), onClick = onChangePassword, modifier = Modifier.testTag("settings.chpw"))
        RowDivider()
        TextButton(
            onClick = onSignOut,
            modifier = Modifier.fillMaxWidth().padding(horizontal = SaTokens.Space.S2).testTag("settings.signout")
        ) {
            Text(stringResource(R.string.android_yy_s_signout), color = MaterialTheme.colorScheme.error, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun KeyRow(keys: KeyStatus, actions: AccountActions, onRetry: () -> Unit) {
    when (keys) {
        KeyStatus.Ready -> SettingsRow(stringResource(R.string.product_key_ready), modifier = Modifier.testTag("settings.key"))
        KeyStatus.Checking, KeyStatus.None -> SettingsRow(
            stringResource(R.string.product_keys_checking),
            modifier = Modifier.testTag("settings.key")
        )
        KeyStatus.Setup -> SettingsRow(
            stringResource(R.string.product_ck_no_key),
            value = stringResource(R.string.product_key_setup_cta),
            onClick = actions.setUpKeys,
            modifier = Modifier.testTag("settings.key")
        )
        KeyStatus.Pair -> SettingsRow(
            stringResource(R.string.product_ck_no_key),
            value = stringResource(R.string.product_pair_h),
            onClick = actions.pair,
            modifier = Modifier.testTag("settings.key")
        )
        KeyStatus.Error -> SettingsRow(
            stringResource(R.string.product_keys_error),
            value = stringResource(R.string.common_retry),
            onClick = onRetry,
            modifier = Modifier.testTag("settings.key")
        )
        KeyStatus.Legacy -> SettingsRow(stringResource(R.string.product_keys_legacy), modifier = Modifier.testTag("settings.key"))
        KeyStatus.Rejected, KeyStatus.Refused -> {
            Column(
                Modifier.padding(SaTokens.Space.S4).testTag("settings.key"),
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)
            ) {
                Text(
                    stringResource(
                        if (keys ==
                            KeyStatus.Rejected
                        ) {
                            R.string.product_key_change_unverified
                        } else {
                            R.string.product_keys_refused
                        }
                    ),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.error
                )
                Text(
                    stringResource(
                        if (keys ==
                            KeyStatus.Rejected
                        ) {
                            R.string.product_key_change_unverified_p
                        } else {
                            R.string.product_keys_refused_p
                        }
                    ),
                    style = MaterialTheme.typography.bodySmall
                )
                Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                    TextButton(onClick = actions.pair) { Text(stringResource(R.string.product_pair_again)) }
                    TextButton(onClick = actions.phrase) { Text(stringResource(R.string.product_use_phrase)) }
                }
            }
        }
    }
}

@Composable
private fun ChangePasswordDialog(viewModel: AccountViewModel, onDismiss: () -> Unit, onDone: () -> Unit) {
    var current by rememberSaveable { mutableStateOf("") }
    var next by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    var tried by rememberSaveable { mutableStateOf(false) }
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val nextProblem = if (tried) passwordProblem(next, signUp = true)?.let { stringResource(it) } else null
    val mismatch = if (tried && next != confirm) stringResource(R.string.product_password_mismatch) else null
    val currentProblem = if (tried && current.isEmpty()) stringResource(R.string.product_password_required) else null
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.android_yy_s_chpw)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                PasswordField(current, {
                    current = it
                }, stringResource(R.string.common_cp_cur), "chpw.current", currentProblem, imeAction = ImeAction.Next)
                PasswordField(
                    next,
                    {
                        next = it
                    },
                    stringResource(
                        R.string.common_cp_new
                    ),
                    "chpw.new",
                    nextProblem,
                    stringResource(R.string.product_password_hint),
                    ImeAction.Next
                )
                PasswordField(confirm, { confirm = it }, stringResource(R.string.common_cp_conf), "chpw.confirm", mismatch)
                Text(stringResource(R.string.product_chpw_note), style = MaterialTheme.typography.bodySmall)
                AccountError(error)
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, modifier = Modifier.testTag("chpw.save"), onClick = {
                tried = true
                if (current.isNotEmpty() &&
                    passwordProblem(next, true) == null &&
                    next == confirm
                ) {
                    viewModel.changePassword(current, next, onDone)
                }
            }) { Text(stringResource(R.string.common_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.android_cancel)) } }
    )
}
