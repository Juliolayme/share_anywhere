package app.shareanywhere.ui.account

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.ui.components.FlowTopBar
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.components.SwitchRow
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

/** Account screen frame (design `sc.signin` / `sc2.*`): back arrow, scrollable column, actions at the bottom. */
@Composable
fun AccountFrame(tag: String, title: String, onBack: (() -> Unit)?, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().imePadding().testTag(tag)) {
        if (onBack != null) {
            FlowTopBar(title = title, navIcon = R.drawable.ic_arrow_back, navLabel = stringResource(R.string.product_back), onNav = onBack)
        } else {
            Spacer(Modifier.size(SaTokens.Space.S6))
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = SaTokens.Space.S4 + SaTokens.Space.S1, vertical = SaTokens.Space.S1),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3 + SaTokens.Space.S1),
            content = content
        )
    }
}

@Composable
fun AccountError(text: UiText?) {
    if (text == null) return
    Text(
        str(text.id, *text.args.toList().toTypedArray()),
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.testTag("account.error").semantics { liveRegion = LiveRegionMode.Polite }
    )
}

@Composable
fun EmailField(value: String, onChange: (String) -> Unit, error: String?, tag: String, imeAction: ImeAction = ImeAction.Next) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(stringResource(R.string.android_yy_email)) },
        placeholder = { Text("you@example.com") },
        singleLine = true,
        isError = error != null,
        supportingText = error?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = imeAction, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth().testTag(tag)
    )
}

@Composable
fun PasswordField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    tag: String,
    error: String? = null,
    hint: String? = null,
    imeAction: ImeAction = ImeAction.Done,
    onDone: () -> Unit = {}
) {
    var shown by rememberSaveable { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        isError = error != null,
        supportingText = (error ?: hint)?.let { { Text(it) } },
        visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = imeAction, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        trailingIcon = {
            IconButton(onClick = { shown = !shown }) {
                Icon(
                    painterResource(if (shown) R.drawable.ic_visibility_off else R.drawable.ic_visibility),
                    contentDescription = stringResource(if (shown) R.string.product_password_hide else R.string.product_password_show)
                )
            }
        },
        modifier = Modifier.fillMaxWidth().testTag(tag)
    )
}

/** AC-1 Sign in (design `signin`): the device is not added here; AC-4 follows. */
@Composable
fun SignInScreen(
    onBack: () -> Unit,
    onSignedIn: () -> Unit,
    onCreate: () -> Unit,
    onForgot: () -> Unit,
    viewModel: AccountViewModel = hiltViewModel()
) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var tried by rememberSaveable { mutableStateOf(false) }
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val emailError = if (tried && !validEmail(email)) stringResource(R.string.product_email_invalid) else null
    val pwError = if (tried) passwordProblem(password, signUp = false)?.let { stringResource(it) } else null
    val submit = {
        tried = true
        if (validEmail(email) && passwordProblem(password, false) == null) viewModel.signIn(email, password, onSignedIn)
    }
    AccountFrame(ScreenIds.SIGNIN, "", onBack) {
        Text(
            stringResource(R.string.android_yy_signin),
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics {
                heading()
            }
        )
        Text(stringResource(R.string.android_yy_si_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
        EmailField(email, { email = it }, emailError, "signin.email")
        PasswordField(password, { password = it }, stringResource(R.string.android_yy_pw), "signin.password", pwError, onDone = submit)
        TextButton(onClick = onForgot, modifier = Modifier.testTag("signin.forgot")) { Text(stringResource(R.string.android_yy_forgot)) }
        AccountError(error)
        Spacer(Modifier.weight(1f))
        PrimaryButton(
            stringResource(R.string.android_yy_signin),
            onClick = submit,
            busy = busy,
            modifier = Modifier.testTag("signin.submit")
        )
        SecondaryButton(
            stringResource(R.string.android_yy_create),
            onClick = onCreate,
            modifier = Modifier.fillMaxWidth().testTag("signin.create")
        )
    }
}

/** AC-2 Create account (design `signup`, without the name field the API does not have; DESIGN_DEVIATIONS K2). */
@Composable
fun SignUpScreen(onBack: () -> Unit, onSignedUp: () -> Unit, onSignIn: () -> Unit, viewModel: AccountViewModel = hiltViewModel()) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var tried by rememberSaveable { mutableStateOf(false) }
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val emailError = if (tried && !validEmail(email)) stringResource(R.string.product_email_invalid) else null
    val pwError = if (tried) passwordProblem(password, signUp = true)?.let { stringResource(it) } else null
    val submit = {
        tried = true
        if (validEmail(email) && passwordProblem(password, true) == null) viewModel.signUp(email, password, onSignedUp)
    }
    AccountFrame(ScreenIds.SIGNUP, stringResource(R.string.android_yy_su_h), onBack) {
        Text(stringResource(R.string.android_yy_su_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
        EmailField(email, { email = it }, emailError, "signup.email")
        PasswordField(
            password,
            { password = it },
            stringResource(R.string.android_yy_pw),
            "signup.password",
            pwError,
            hint = stringResource(R.string.product_password_hint),
            onDone = submit
        )
        if (password.isNotEmpty()) StrengthMeter(passwordStrength(password))
        AccountError(error)
        Spacer(Modifier.weight(1f))
        PrimaryButton(stringResource(R.string.android_yy_su_h), onClick = submit, busy = busy, modifier = Modifier.testTag("signup.submit"))
        TextButton(onClick = onSignIn, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text(stringResource(R.string.android_yy_have))
        }
    }
}

@Composable
private fun StrengthMeter(level: Int) {
    val p = LocalSaPalette.current
    val label =
        stringResource(
            when (level) {
                0 -> R.string.product_pw_weak
                1 -> R.string.product_pw_fair
                2 -> R.string.product_pw_good
                else -> R.string.product_pw_strong
            }
        )
    val text = str(R.string.product_pw_strength, "level" to label)
    Column(Modifier.semantics(mergeDescendants = true) { contentDescription = text }) {
        LinearProgressIndicator(
            progress = { (level + 1) / 4f },
            color = if (level <= 0) {
                p.danger
            } else if (level == 1) {
                p.warningInk
            } else {
                p.success
            },
            trackColor = p.track,
            modifier = Modifier.fillMaxWidth()
        )
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** AC-3 Reset password (design `forgot`): request form, then "Check your inbox" whatever the address. */
@Composable
fun ForgotScreen(onBack: () -> Unit, viewModel: AccountViewModel = hiltViewModel()) {
    var email by rememberSaveable { mutableStateOf("") }
    var sent by rememberSaveable { mutableStateOf(false) }
    var tried by rememberSaveable { mutableStateOf(false) }
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val p = LocalSaPalette.current
    AccountFrame(ScreenIds.FORGOT, stringResource(R.string.android_yy_fp_h), onBack) {
        if (!sent) {
            Text(stringResource(R.string.android_yy_fp_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
            EmailField(
                email,
                { email = it },
                if (tried &&
                    !validEmail(email)
                ) {
                    stringResource(R.string.product_email_invalid)
                } else {
                    null
                },
                "forgot.email",
                ImeAction.Done
            )
            AccountError(error)
            PrimaryButton(stringResource(R.string.android_yy_fp_btn), busy = busy, modifier = Modifier.testTag("forgot.submit"), onClick = {
                tried = true
                if (validEmail(email)) viewModel.requestReset(email) { sent = true }
            })
        } else {
            Column(
                Modifier.fillMaxWidth().padding(vertical = SaTokens.Space.S6).testTag("forgot.sent").semantics {
                    liveRegion =
                        LiveRegionMode.Polite
                },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
            ) {
                Box(Modifier.size(72.dp).clip(CircleShape).background(p.receiveSoft), contentAlignment = Alignment.Center) {
                    Icon(
                        painterResource(R.drawable.ic_mark_email_read),
                        contentDescription = null,
                        tint = p.receiveInk,
                        modifier = Modifier.size(34.dp)
                    )
                }
                Text(stringResource(R.string.android_yy_fp_sent_h), style = MaterialTheme.typography.titleLarge)
                Text(stringResource(R.string.android_yy_fp_sent_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(stringResource(R.string.product_fp_open_link), color = MaterialTheme.colorScheme.onSurfaceVariant)
                SecondaryButton(stringResource(R.string.android_yy_back_si), onClick = onBack)
            }
        }
    }
}

/**
 * AC-4 After sign-in choices (`trust`): Add this device (on) and, while on, Copy this device's transfer history (off).
 * Adding routes by key state: AC-5 (no key yet), AC-6 (key missing here) or AC-8.
 */
@Composable
fun TrustScreen(onNext: (KeyStatus) -> Unit, viewModel: AccountViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    var add by rememberSaveable { mutableStateOf(true) }
    var copy by rememberSaveable { mutableStateOf(false) }
    AccountFrame(ScreenIds.TRUST, "", null) {
        Text(
            stringResource(R.string.product_add_device),
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.semantics {
                heading()
            }
        )
        state.email?.let { Text(str(R.string.product_signed_in_as, "email" to it), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        SaCard {
            SwitchRow(
                label = stringResource(R.string.product_add_device),
                checked = add,
                onCheckedChange = { add = it },
                description = stringResource(if (add) R.string.product_add_device_p else R.string.product_add_device_off_p_device),
                modifier = Modifier.testTag("trust.add")
            )
            if (add) {
                RowDivider()
                SwitchRow(
                    label = stringResource(R.string.product_copy_history),
                    checked = copy,
                    onCheckedChange = { copy = it },
                    description = stringResource(R.string.product_copy_history_p),
                    modifier = Modifier.testTag("trust.copy")
                )
            }
        }
        AccountError(error)
        Spacer(Modifier.weight(1f))
        PrimaryButton(stringResource(R.string.android_cont), busy = busy, modifier = Modifier.testTag("trust.continue"), onClick = {
            viewModel.trustContinue(add, add && copy, onNext)
        })
    }
}

/** AC-8 You're set up (design `checklist`), each step with its action when it is not done. */
@Composable
fun ChecklistScreen(
    fromClipboard: Boolean,
    onContinue: () -> Unit,
    onClipboard: () -> Unit,
    onAddDevice: () -> Unit,
    onSetUpKeys: () -> Unit,
    onPair: () -> Unit,
    clipboardEnabled: Boolean,
    viewModel: AccountViewModel = hiltViewModel()
) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { viewModel.retryKeys() }
    AccountFrame(ScreenIds.CHECKLIST, "", null) {
        Text(
            stringResource(R.string.android_yy_ck_h),
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics {
                heading()
            }
        )
        Text(stringResource(R.string.android_yy_ck_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
        SaCard {
            CheckRow(stringResource(R.string.android_yy_ck_1), true, "ck.share")
            RowDivider()
            CheckRow(
                s.email?.let {
                    str(R.string.product_signed_in_as, "email" to it)
                } ?: stringResource(R.string.android_yy_ck_2),
                s.signedIn,
                "ck.signed"
            )
            RowDivider()
            CheckRow(
                stringResource(if (s.added) R.string.android_yy_ck_3 else R.string.product_ck_not_added),
                s.added,
                "ck.added",
                action = if (!s.added) stringResource(R.string.product_add_device_btn) to onAddDevice else null
            )
            if (s.added) {
                RowDivider()
                val ready = s.keys == KeyStatus.Ready
                CheckRow(
                    stringResource(if (ready) R.string.product_key_ready else R.string.product_ck_no_key),
                    ready,
                    "ck.key",
                    action =
                    when (s.keys) {
                        KeyStatus.Setup -> stringResource(R.string.product_key_setup_cta) to onSetUpKeys
                        KeyStatus.Pair, KeyStatus.Rejected, KeyStatus.Refused -> stringResource(R.string.product_pair_h) to onPair
                        else -> null
                    }
                )
                RowDivider()
                CheckRow(
                    stringResource(if (s.historySync) R.string.product_ck_sync_on else R.string.product_ck_sync_off),
                    s.historySync,
                    "ck.sync"
                )
            }
        }
        Spacer(Modifier.weight(1f))
        if (clipboardEnabled) {
            PrimaryButton(
                stringResource(R.string.android_yy_ck_btn),
                onClick = onClipboard,
                modifier = Modifier.testTag("checklist.clipboard")
            )
        }
        if (!fromClipboard || !clipboardEnabled) {
            SecondaryButton(
                stringResource(R.string.android_cont),
                onClick = onContinue,
                modifier = Modifier.fillMaxWidth().testTag("checklist.continue")
            )
        }
    }
}

@Composable
private fun CheckRow(label: String, done: Boolean, tag: String, action: Pair<String, () -> Unit>? = null) {
    val p = LocalSaPalette.current
    val state = stringResource(if (done) R.string.product_ck_done else R.string.product_ck_todo)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = SaTokens.TouchTarget + SaTokens.Space.S2)
            .padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        StateIcon(if (done) R.drawable.ic_check_circle else R.drawable.ic_radio_button_unchecked, if (done) p.receiveInk else p.fg3, state)
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (action != null) TextButton(onClick = action.second) { Text(action.first) }
    }
}

@Composable
private fun StateIcon(@DrawableRes icon: Int, tint: androidx.compose.ui.graphics.Color, description: String) {
    Icon(painterResource(icon), contentDescription = description, tint = tint, modifier = Modifier.size(SaTokens.Space.S6))
}

/** AC-7 Sign out (dialog from Settings): keep or clear local history; the device continues as a new guest. */
@Composable
fun SignOutDialog(onDismiss: () -> Unit, onSignedOut: () -> Unit, viewModel: AccountViewModel = hiltViewModel()) {
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val hasHistory by viewModel.hasHistory.collectAsStateWithLifecycle()
    var clear by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.product_signout_h_device)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                Text(stringResource(R.string.product_signout_p_device))
                if (hasHistory) {
                    Text(stringResource(R.string.product_signout_history_device), style = MaterialTheme.typography.titleSmall)
                    ChoiceLine(stringResource(R.string.product_signout_keep), !clear, "signout.keep") { clear = false }
                    ChoiceLine(stringResource(R.string.product_signout_clear), clear, "signout.clear") { clear = true }
                }
                error?.let { Text(context.getString(R.string.product_signout_failed), color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                viewModel.signOut(clear, onSignedOut)
            }, enabled = !busy, modifier = Modifier.testTag("signout.confirm")) {
                Text(stringResource(R.string.android_yy_s_signout), color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.android_cancel)) } }
    )
}

@Composable
private fun ChoiceLine(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = SaTokens.TouchTarget)
            .androidSelectable(selected, onClick)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
    ) {
        androidx.compose.material3.RadioButton(selected = selected, onClick = null)
        Text(label)
    }
}

private fun Modifier.androidSelectable(selected: Boolean, onClick: () -> Unit) =
    this.selectable(selected = selected, role = androidx.compose.ui.semantics.Role.RadioButton, onClick = onClick)
