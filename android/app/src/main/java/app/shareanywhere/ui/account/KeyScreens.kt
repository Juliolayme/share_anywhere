package app.shareanywhere.ui.account

import android.content.ClipData
import android.content.ClipboardManager
import android.os.PersistableBundle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.account.crypto.Phrase
import app.shareanywhere.qr.QrCode
import app.shareanywhere.sharing.secondsUntil
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.format.formatCountdown
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.SaTokens
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * AC-5 Account Data Key setup (`key-setup`, the Web's screen): the key and the 12-word phrase are made on the device; the
 * words show once with the warning; "I wrote down my recovery phrase" enables Continue, which sends the setup and only
 * then stores the key. `409 keys_exist` goes to AC-6.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KeySetupScreen(onBack: () -> Unit, onDone: () -> Unit, onKeysExist: () -> Unit, viewModel: AccountViewModel = hiltViewModel()) {
    val phrase by viewModel.phrase.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    var saved by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { viewModel.prepareKeys() }
    SecureWindow()
    AccountFrame(ScreenIds.KEY_SETUP, stringResource(R.string.product_key_setup_h), onBack) {
        Text(stringResource(R.string.product_key_setup_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
        val words = phrase?.split(' ')
        if (words == null) {
            if (error == null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                    CircularProgressIndicator(Modifier.size(SaTokens.Space.S6))
                    Text(stringResource(R.string.product_key_generating))
                }
            }
        } else {
            SaCard(Modifier.testTag("key-setup.words")) {
                FlowRow(
                    Modifier.padding(SaTokens.Space.S4).semantics(mergeDescendants = true) {},
                    horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2),
                    verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
                ) {
                    words.forEachIndexed { i, w ->
                        Text(
                            "${i + 1}. $w",
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.width(132.dp)
                        )
                    }
                }
            }
            InlineNotice(NoticeKind.Warning, R.drawable.ic_error, stringResource(R.string.product_key_setup_warn))
            // The whole row toggles (one TalkBack target, 48 dp), not only the box.
            Row(
                Modifier
                    .fillMaxWidth()
                    .toggleable(value = saved, role = androidx.compose.ui.semantics.Role.Checkbox, onValueChange = { saved = it })
                    .testTag("key-setup.saved"),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Checkbox(checked = saved, onCheckedChange = null)
                Text(stringResource(R.string.product_key_saved_check))
            }
        }
        AccountError(error)
        Spacer(Modifier.weight(1f))
        if (words == null && error != null) {
            PrimaryButton(stringResource(R.string.common_retry), onClick = {
                viewModel.prepareKeys()
            }, modifier = Modifier.testTag("key-setup.retry"))
        } else {
            PrimaryButton(
                stringResource(R.string.android_cont),
                enabled = words != null && saved,
                busy = busy && words != null,
                modifier = Modifier.testTag("key-setup.continue"),
                onClick = { viewModel.commitKeys(onDone, onKeysExist) }
            )
        }
    }
}

/** The recovery phrase and pairing codes are kept out of screenshots and the recents preview while shown. */
@Composable
private fun SecureWindow() {
    val activity = androidx.activity.compose.LocalActivity.current ?: return
    DisposableEffect(Unit) {
        activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE) }
    }
}

/**
 * AC-6 Pair this device (`key-pair`): QR plus the copyable `sa1.…` code with the 10-minute countdown, polling every 2 s;
 * expired or failed codes offer New code; or Use recovery phrase (one field with suggestions, word count, checksum).
 */
@Composable
fun KeyPairScreen(phraseFirst: Boolean, onBack: () -> Unit, onDone: () -> Unit, viewModel: AccountViewModel = hiltViewModel()) {
    var phraseMode by rememberSaveable { mutableStateOf(phraseFirst) }
    val pair by viewModel.pair.collectAsStateWithLifecycle()
    LaunchedEffect(phraseMode) { if (phraseMode) viewModel.stopPairing() else viewModel.startPairing() }
    LaunchedEffect(pair) { if (pair is PairState.Done) onDone() }
    AccountFrame(ScreenIds.KEY_PAIR, stringResource(if (phraseMode) R.string.product_phrase_h else R.string.product_pair_h), onBack) {
        if (phraseMode) {
            PhraseEntry(viewModel, onDone)
            TextButton(onClick = {
                phraseMode = false
            }, modifier = Modifier.testTag("key-pair.use-pairing")) { Text(stringResource(R.string.product_use_pairing)) }
        } else {
            Text(stringResource(R.string.product_pair_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.product_pair_steps), style = MaterialTheme.typography.bodyMedium)
            PairingPanel(pair, onNewCode = viewModel::startPairing, onExpired = viewModel::pairingExpired)
            TextButton(onClick = {
                phraseMode = true
            }, modifier = Modifier.testTag("key-pair.use-phrase")) { Text(stringResource(R.string.product_use_phrase)) }
        }
    }
}

@Composable
private fun PairingPanel(pair: PairState, onNewCode: () -> Unit, onExpired: () -> Unit) {
    when (pair) {
        PairState.Starting, PairState.Done ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                CircularProgressIndicator(Modifier.size(SaTokens.Space.S6))
                Text(stringResource(if (pair == PairState.Done) R.string.product_pair_done else R.string.product_pair_waiting))
            }
        is PairState.Waiting -> {
            SecureWindow()
            var left by rememberSaveable(pair.expiresAt) { mutableLongStateOf(secondsUntil(pair.expiresAt, 0)) }
            LaunchedEffect(pair.expiresAt) {
                while (true) {
                    left = secondsUntil(pair.expiresAt, 0)
                    if (left <= 0) {
                        onExpired()
                        break
                    }
                    delay(1_000)
                }
            }
            val context = LocalContext.current
            val snackbar = LocalSnackbar.current
            val scope = androidx.compose.runtime.rememberCoroutineScope()
            SaCard(Modifier.testTag("key-pair.code")) {
                Column(
                    Modifier.fillMaxWidth().padding(SaTokens.Space.S4),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
                ) {
                    QrCode(pair.payload, stringResource(R.string.product_pair_qr_aria), size = 200.dp)
                    Text(stringResource(R.string.product_pair_code_label), style = MaterialTheme.typography.labelMedium)
                    Text(
                        pair.payload,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("key-pair.payload")
                    )
                    Text(
                        formatCountdown(left),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.testTag("key-pair.countdown")
                    )
                    SecondaryButton(stringResource(R.string.product_pair_copy_code), icon = R.drawable.ic_content_copy, onClick = {
                        val clip = ClipData.newPlainText(context.getString(R.string.product_pair_code_label), pair.payload)
                        clip.description.extras =
                            PersistableBundle().apply { putBoolean(app.shareanywhere.clipboard.ClipboardRuntime.EXTRA_IS_SENSITIVE, true) }
                        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
                        scope.launch { snackbar.showSnackbar(context.getString(R.string.phrases_code_copied)) }
                    })
                }
            }
            Text(
                stringResource(R.string.product_pair_waiting),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
            )
        }
        PairState.Expired -> {
            InlineNotice(
                NoticeKind.Warning,
                R.drawable.ic_timer_off,
                stringResource(R.string.product_pair_expired),
                Modifier.testTag("key-pair.expired")
            )
            PrimaryButton(
                stringResource(R.string.product_pair_new_code),
                onClick = onNewCode,
                modifier = Modifier.testTag("key-pair.new-code")
            )
        }
        is PairState.Failed -> {
            InlineNotice(
                NoticeKind.Error,
                R.drawable.ic_error,
                str(pair.message.id, *pair.message.args.toList().toTypedArray()),
                Modifier.testTag("key-pair.failed")
            )
            PrimaryButton(stringResource(R.string.product_pair_new_code), onClick = onNewCode)
        }
    }
}

@Composable
private fun PhraseEntry(viewModel: AccountViewModel, onDone: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    SecureWindow()
    val words = Phrase.normalize(text).split(' ').filter { it.isNotEmpty() }
    val last = if (text.endsWith(" ")) "" else words.lastOrNull().orEmpty()
    val unknown = words.dropLast(if (last.isEmpty()) 0 else 1).firstOrNull { it !in Phrase.wordlist }
    val problem = unknown?.let { UiText(R.string.product_phrase_unknown, mapOf("word" to it)) } ?: viewModel.phraseProblem(text)
    val suggestions = if (last.length >= 2) Phrase.wordlist.filter { it.startsWith(last) && it != last }.take(4) else emptyList()
    Text(stringResource(R.string.product_phrase_p), color = MaterialTheme.colorScheme.onSurfaceVariant)
    OutlinedTextField(
        value = text,
        onValueChange = {
            text = it
            viewModel.clearError()
        },
        label = { Text(stringResource(R.string.product_phrase_label)) },
        minLines = 3,
        isError = problem != null,
        supportingText = {
            Text(
                problem?.let { str(it.id, *it.args.toList().toTypedArray()) }
                    ?: str(R.string.product_phrase_count, "n" to words.size.coerceAtMost(12))
            )
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth().testTag("key-pair.phrase")
    )
    if (suggestions.isNotEmpty()) {
        Text(stringResource(R.string.product_phrase_suggestions), style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
            suggestions.forEach { s ->
                SuggestionChip(onClick = { text = (words.dropLast(1) + s).joinToString(" ") + " " }, label = { Text(s) })
            }
        }
    }
    AccountError(error)
    PrimaryButton(
        if (busy) {
            stringResource(
                R.string.product_phrase_unlocking
            ).replace("{percent}%", "").trim()
        } else {
            stringResource(R.string.product_phrase_unlock)
        },
        enabled = words.size == 12 && problem == null,
        busy = busy,
        modifier = Modifier.testTag("key-pair.unlock"),
        onClick = { viewModel.recover(text, onDone) }
    )
}
