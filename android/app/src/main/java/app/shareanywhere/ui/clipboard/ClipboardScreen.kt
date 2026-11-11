package app.shareanywhere.ui.clipboard

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.account.AccountState
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.clipboard.ClipItem
import app.shareanywhere.clipboard.ClipboardUi
import app.shareanywhere.clipboard.LoadError
import app.shareanywhere.clipboard.SendError
import app.shareanywhere.clipboard.SensitiveKind
import app.shareanywhere.ui.account.UiText
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.EmptyState
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.ScreenHeader
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.history.whenText
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

/** Where the Clipboard tab leads (account graph and CB-6). */
class ClipboardActions(
    val signIn: () -> Unit,
    val create: () -> Unit,
    val addDevice: () -> Unit,
    val setUpKeys: () -> Unit,
    val pair: () -> Unit,
    val phrase: () -> Unit,
    val settings: () -> Unit
)

private enum class Filter { All, Mine, Others, Links }

private val URL = Regex("https?://\\S+", RegexOption.IGNORE_CASE)

@Composable
private fun UiText.text() = str(id, *args.toList().toTypedArray())

/**
 * CB-1…CB-5 (design `clipboard`; docs/UX_SCREEN_MAP.md §10). Guests see the account-required intro and nothing here touches
 * `ClipboardManager`; a signed-in device that is not ready gets the step it needs; a ready device gets Sync Clipboard, the
 * capture status, the timeline and the item sheet. [syncRequest] runs one Sync (the notification's action).
 */
@Composable
fun ClipboardScreen(
    actions: ClipboardActions,
    syncRequest: Int = 0,
    onSyncHandled: () -> Unit = {},
    viewModel: ClipboardViewModel = hiltViewModel()
) {
    val account by viewModel.accountState.collectAsStateWithLifecycle()
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().testTag(ScreenIds.CLIPBOARD)) {
        ScreenHeader(stringResource(R.string.android_clip), modifier = Modifier.padding(horizontal = SaTokens.Space.S4)) {
            if (account.signedIn) E2eChip()
        }
        when {
            !account.signedIn -> GuestIntro(actions)
            !account.added -> NotReady(
                R.drawable.ic_devices,
                stringResource(R.string.product_add_device_clipboard),
                stringResource(R.string.product_not_added_p_device),
                "clipboard.add-device"
            ) {
                PrimaryButton(
                    stringResource(R.string.product_add_device_btn),
                    onClick = actions.addDevice,
                    modifier = Modifier.testTag("clipboard.add")
                )
            }
            account.keys != KeyStatus.Ready -> KeyStep(account, actions, onRetry = { viewModel.retryKeys() })
            !ui.active -> SkeletonList(4, stringResource(R.string.product_cb_loading), Modifier.padding(SaTokens.Space.S4))
            else -> ClipboardHome(ui, actions, syncRequest, onSyncHandled, viewModel)
        }
    }
}

@Composable
private fun E2eChip() {
    val p = LocalSaPalette.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
        Icon(painterResource(R.drawable.ic_lock), contentDescription = null, tint = p.receiveInk, modifier = Modifier.size(16.dp))
        Text(stringResource(R.string.android_e2e), style = MaterialTheme.typography.labelMedium, color = p.receiveInk)
    }
}

/** CB-1: what it does, end-to-end encrypted, needs an account; Sign in / Create account. No clipboard access. */
@Composable
private fun GuestIntro(actions: ClipboardActions) {
    val p = LocalSaPalette.current
    Column(
        Modifier.fillMaxSize().verticalScrollCompat().padding(
            horizontal = SaTokens.Space.S4 + SaTokens.Space.S1,
            vertical = SaTokens.Space.S2
        ).testTag("clipboard.intro"),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S4)
    ) {
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(20.dp)).background(p.sendSoft), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_content_paste), contentDescription = null, tint = p.sendInk, modifier = Modifier.size(32.dp))
        }
        Text(
            stringResource(R.string.android_vv_k140),
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.semantics {
                heading()
            }
        )
        Text(stringResource(R.string.product_sign_in_clipboard), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Point(R.drawable.ic_lock, p.receiveInk, stringResource(R.string.android_vv_k142))
        Point(R.drawable.ic_touch_app, p.sendInk, stringResource(R.string.android_vv_k143))
        Point(R.drawable.ic_swap_horiz, p.fg2, stringResource(R.string.android_vv_k144))
        PrimaryButton(stringResource(R.string.android_yy_signin), onClick = actions.signIn, modifier = Modifier.testTag("clipboard.signin"))
        OutlinedButton(onClick = actions.create, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("clipboard.create")) {
            Text(stringResource(R.string.android_create_acc))
        }
    }
}

@Composable
private fun Modifier.verticalScrollCompat() = this.verticalScrollState()

@Composable
private fun Modifier.verticalScrollState() = this.verticalScroll(rememberScrollState())

@Composable
private fun Point(@DrawableRes icon: Int, tint: Color, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
        Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun NotReady(@DrawableRes icon: Int, title: String, body: String, tag: String, action: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(SaTokens.Space.S4).testTag(tag), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
        InlineNotice(NoticeKind.Info, icon, title, body = body)
        action()
    }
}

/** Signed in and added, but the key is not usable here: Set up encryption, CB-3 Pair, or the key problem banners. */
@Composable
private fun KeyStep(s: AccountState, actions: ClipboardActions, onRetry: () -> Unit) {
    when (s.keys) {
        KeyStatus.Setup -> NotReady(
            R.drawable.ic_key,
            stringResource(R.string.product_cb_setup_h),
            stringResource(R.string.product_cb_setup_p),
            "clipboard.setup"
        ) {
            PrimaryButton(
                stringResource(R.string.product_key_setup_cta),
                onClick = actions.setUpKeys,
                modifier = Modifier.testTag("clipboard.setup-keys")
            )
        }
        KeyStatus.Pair -> NotReady(
            R.drawable.ic_key,
            stringResource(R.string.product_cb_pair_h),
            stringResource(R.string.product_cb_pair_p),
            "clipboard.pair"
        ) {
            PrimaryButton(
                stringResource(R.string.product_pair_h),
                onClick = actions.pair,
                modifier = Modifier.testTag("clipboard.pair-device")
            )
            TextButton(onClick = actions.phrase) { Text(stringResource(R.string.product_use_phrase)) }
        }
        KeyStatus.Rejected, KeyStatus.Refused -> {
            val rejected = s.keys == KeyStatus.Rejected
            Column(
                Modifier.padding(SaTokens.Space.S4).testTag("clipboard.key-problem"),
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
            ) {
                InlineNotice(
                    NoticeKind.Error,
                    R.drawable.ic_gpp_bad,
                    stringResource(if (rejected) R.string.product_key_change_unverified else R.string.product_keys_refused),
                    body = stringResource(if (rejected) R.string.product_key_change_unverified_p else R.string.product_keys_refused_p)
                )
                Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                    Button(onClick = actions.pair) { Text(stringResource(R.string.product_pair_again)) }
                    TextButton(onClick = actions.phrase) { Text(stringResource(R.string.product_use_phrase)) }
                }
            }
        }
        KeyStatus.Legacy -> NotReady(R.drawable.ic_error, stringResource(R.string.product_keys_legacy), "", "clipboard.legacy") {}
        KeyStatus.Error -> NotReady(R.drawable.ic_error, stringResource(R.string.product_keys_error), "", "clipboard.key-error") {
            OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
        }
        else -> SkeletonList(3, stringResource(R.string.product_keys_checking), Modifier.padding(SaTokens.Space.S4))
    }
}

/** CB-4 for a ready device. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ClipboardHome(
    ui: ClipboardUi,
    actions: ClipboardActions,
    syncRequest: Int,
    onSyncHandled: () -> Unit,
    viewModel: ClipboardViewModel
) {
    val snap = ui.snapshot
    val syncing by viewModel.syncing.collectAsStateWithLifecycle()
    val outcome by viewModel.outcome.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(Filter.All) }
    var inline by rememberSaveable { mutableStateOf<Int?>(null) }
    var sensitive by remember { mutableStateOf<String?>(null) }
    var paste by rememberSaveable { mutableStateOf(false) }
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmClear by rememberSaveable { mutableStateOf(false) }
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    // One Sync per notification tap: the request is consumed, so coming back to this tab never reads the clipboard again.
    LaunchedEffect(syncRequest) {
        if (syncRequest > 0) {
            onSyncHandled()
            viewModel.syncNow()
        }
    }
    LaunchedEffect(outcome) {
        when (val o = outcome ?: return@LaunchedEffect) {
            is SyncOutcome.Toast -> snackbar.showSnackbar(
                context.getString(o.text.id).let { t ->
                    o.text.args.entries.fold(t) { acc, (k, v) -> acc.replace("{$k}", v) }
                }
            )
            is SyncOutcome.Inline -> inline = o.text.id
            is SyncOutcome.Sensitive -> sensitive = o.text
            SyncOutcome.Paste -> paste = true
        }
        if (outcome !is SyncOutcome.Inline) inline = null
        viewModel.outcomeShown()
    }
    val names = ui.deviceNames
    val me = ui.thisDeviceId
    val origin: (ClipItem) -> String = {
        if (it.origin ==
            me
        ) {
            context.getString(R.string.product_cb_this_device)
        } else {
            names[it.origin]
                ?: context.getString(R.string.product_cb_other_device)
        }
    }
    val now = System.currentTimeMillis()
    val shown =
        snap.items.filter { i ->
            val mine = i.origin == me
            when (filter) {
                Filter.All -> true
                Filter.Mine -> mine
                Filter.Others -> !mine
                Filter.Links -> i.text?.let { URL.containsMatchIn(it) } == true
            } &&
                (query.isBlank() || i.text?.contains(query.trim(), ignoreCase = true) == true)
        }

    LazyColumn(
        Modifier.fillMaxSize().testTag("clipboard.home"),
        contentPadding = PaddingValues(start = SaTokens.Space.S4, end = SaTokens.Space.S4, bottom = SaTokens.Space.S4),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        item {
            PrimaryButton(
                stringResource(R.string.android_sync),
                icon = R.drawable.ic_sync,
                busy = syncing,
                enabled = snap.settings?.paused != true,
                onClick = viewModel::syncNow,
                modifier = Modifier.heightIn(min = 64.dp).testTag("clipboard.sync")
            )
            Text(
                stringResource(R.string.product_cb_sync_p_android),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        inline?.let { id ->
            item {
                Text(
                    stringResource(id),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("clipboard.inline").semantics {
                        liveRegion =
                            LiveRegionMode.Polite
                    }
                )
            }
        }
        sensitive?.let { text ->
            item {
                InlineNotice(
                    NoticeKind.Warning,
                    R.drawable.ic_shield,
                    stringResource(
                        R.string.product_cb_sensitive_h
                    ),
                    Modifier.testTag("clipboard.sensitive"),
                    body = stringResource(R.string.product_cb_sensitive_p),
                    action = {
                        Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                            TextButton(onClick = {
                                sensitive = null
                                viewModel.send(text, force = true)
                            }, modifier = Modifier.testTag("clipboard.sync-anyway")) {
                                Text(stringResource(R.string.product_cb_sync_anyway))
                            }
                            TextButton(onClick = { sensitive = null }) { Text(stringResource(R.string.product_cb_dont_sync)) }
                        }
                    }
                )
            }
        }
        item {
            StatusPanel(ui, onPause = {
                viewModel.setPaused(true)
            }, onResume = { viewModel.setPaused(false) }, onAuto = viewModel::setAutoCapture)
        }
        banners(ui, viewModel, actions)
        items(snap.skipped, key = { "skip-" + it.id }) { s ->
            InlineNotice(
                NoticeKind.Warning,
                R.drawable.ic_shield,
                stringResource(if (s.kind == SensitiveKind.FLAGGED) R.string.product_cb_flagged_row else R.string.product_cb_skipped_row),
                Modifier.testTag("clipboard.skipped"),
                onDismiss = { viewModel.dismissSkipped(s.id) }
            )
        }
        item {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text(stringResource(R.string.android_yy_cb_search)) },
                leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier.fillMaxWidth().testTag("clipboard.search").semantics {
                    contentDescription =
                        context.getString(R.string.android_yy_cb_search)
                }
            )
        }
        item {
            Row(
                Modifier.horizontalScroll(rememberScrollState()).semantics {
                    contentDescription =
                        context.getString(R.string.product_cb_filter)
                },
                horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
            ) {
                listOf(
                    Filter.All to R.string.android_yy_f_all,
                    Filter.Mine to R.string.product_cb_f_mine_device,
                    Filter.Others to R.string.product_cb_f_others,
                    Filter.Links to R.string.android_yy_f_links
                ).forEach { (f, label) ->
                    FilterChip(selected = filter == f, onClick = {
                        filter = f
                    }, label = {
                        Text(stringResource(label))
                    }, modifier = Modifier.heightIn(min = 48.dp).testTag("clipboard.filter.${f.name.lowercase()}"))
                }
            }
        }
        when {
            !snap.loaded || (!snap.synced && snap.items.isEmpty() && snap.loadError == null) -> item {
                SkeletonList(4, stringResource(R.string.product_cb_loading))
            }
            snap.items.isEmpty() && snap.loadError == LoadError.OFFLINE ->
                item {
                    EmptyState(
                        R.drawable.ic_cloud_off,
                        stringResource(R.string.product_identity_offline),
                        stringResource(R.string.product_cb_offline_empty_p),
                        Modifier.testTag("clipboard.offline")
                    )
                }
            snap.items.isEmpty() && snap.loadError != null ->
                item {
                    InlineNotice(
                        NoticeKind.Error,
                        R.drawable.ic_error,
                        stringResource(
                            R.string.product_cb_load_failed
                        ),
                        Modifier.testTag("clipboard.load-error"),
                        action = {
                            TextButton(onClick = viewModel::refresh) { Text(stringResource(R.string.common_retry)) }
                        }
                    )
                }
            snap.items.isEmpty() -> item {
                EmptyState(
                    R.drawable.ic_inbox,
                    stringResource(R.string.android_yy_cb_empty_h),
                    stringResource(R.string.android_yy_cb_empty_p),
                    Modifier.testTag("clipboard.empty")
                )
            }
            shown.isEmpty() -> item {
                Text(
                    stringResource(R.string.android_yy_nomatch),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(SaTokens.Space.S3).testTag("clipboard.nomatch")
                )
            }
            else ->
                items(shown, key = { it.id }) { item ->
                    ClipRow(item, origin(item), whenText(item.createdAt, now), onOpen = {
                        open = item.id
                    }, onCopy = { viewModel.copy(item.id) })
                }
        }
        if (snap.items.isNotEmpty()) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val days = snap.settings?.retentionDays ?: 7
                    Text(
                        if (days == 1) stringResource(R.string.product_cb_keep_note_1) else str(R.string.product_cb_keep_note, "n" to days),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { confirmClear = true }, modifier = Modifier.testTag("clipboard.clear")) {
                        Text(stringResource(R.string.android_yy_cb_clear), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        item {
            TextButton(onClick = actions.settings, modifier = Modifier.testTag("clipboard.settings-link")) {
                Text(stringResource(R.string.product_cb_settings_link))
            }
        }
    }

    snap.items.firstOrNull { it.id == open }?.let { item ->
        ClipDetailSheet(item, origin(item), onDismiss = { open = null }, onCopy = { viewModel.copy(item.id) }, onDelete = {
            open = null
            viewModel.delete(item.id)
        })
    }
    if (paste) {
        PasteDialog(onDismiss = { paste = false }, onSend = {
            paste = false
            viewModel.send(it, force = false)
        })
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

private fun androidx.compose.foundation.lazy.LazyListScope.banners(
    ui: ClipboardUi,
    viewModel: ClipboardViewModel,
    actions: ClipboardActions
) {
    val snap = ui.snapshot
    if (snap.items.isNotEmpty() && snap.loadError == LoadError.OFFLINE) {
        item {
            InlineNotice(
                NoticeKind.Warning,
                R.drawable.ic_cloud_off,
                stringResource(R.string.product_cb_offline_cached),
                Modifier.testTag("clipboard.offline-cached")
            )
        }
    } else if (snap.items.isNotEmpty() && snap.loadError == LoadError.ERROR) {
        item {
            InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_cb_load_failed), action = {
                TextButton(onClick = viewModel::refresh) { Text(stringResource(R.string.common_retry)) }
            })
        }
    }
    if (snap.settingsError) {
        item {
            InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_cb_settings_load_failed), action = {
                TextButton(onClick = viewModel::retrySettings) { Text(stringResource(R.string.common_retry)) }
            })
        }
    }
    when (snap.sendError) {
        SendError.KEY -> item {
            InlineNotice(
                NoticeKind.Error,
                R.drawable.ic_key,
                stringResource(
                    R.string.product_cb_send_key
                ),
                Modifier.testTag("clipboard.send-key"),
                action = {
                    TextButton(onClick = actions.pair) { Text(stringResource(R.string.product_pair_again)) }
                }
            )
        }
        SendError.RATE_LIMITED -> item {
            InlineNotice(NoticeKind.Warning, R.drawable.ic_timer, stringResource(R.string.product_cb_rate_limited))
        }
        SendError.REJECTED -> item { InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_cb_too_large)) }
        SendError.ERROR -> item {
            InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_cb_send_failed), action = {
                TextButton(onClick = viewModel::retrySend) { Text(stringResource(R.string.common_retry)) }
            })
        }
        SendError.OFFLINE -> item {
            val n = snap.queued
            if (n > 0) {
                InlineNotice(
                    NoticeKind.Warning,
                    R.drawable.ic_cloud_off,
                    if (n == 1) stringResource(R.string.product_cb_offline_1) else str(R.string.product_cb_offline_n, "n" to n),
                    Modifier.testTag("clipboard.queued")
                )
            }
        }
        null -> Unit
    }
}

/** The capture status panel (design `cs`): Android's foreground-only rule stated plainly, Pause/Resume, the auto switch. */
@Composable
private fun StatusPanel(ui: ClipboardUi, onPause: () -> Unit, onResume: () -> Unit, onAuto: (Boolean) -> Unit) {
    val p = LocalSaPalette.current
    val status = captureStatus(ui)
    val (bg, fg, icon) =
        when (status) {
            CaptureStatus.Foreground -> Triple(p.sendSoft, p.sendInk, R.drawable.ic_info)
            CaptureStatus.Offline -> Triple(p.warningSoft, p.warningInk, R.drawable.ic_cloud_off)
            CaptureStatus.Paused -> Triple(p.surface2, p.fg2, R.drawable.ic_pause_circle)
            CaptureStatus.Error -> Triple(p.dangerSoft, p.dangerInk, R.drawable.ic_error)
        }
    val title =
        when (status) {
            CaptureStatus.Foreground -> stringResource(R.string.phrases_captures_while_the_app_is_open)
            CaptureStatus.Offline ->
                if (ui.snapshot.queued ==
                    1
                ) {
                    stringResource(R.string.phrases_offline_1_item_queued)
                } else {
                    stringResource(R.string.phrases_offline_queued)
                }
            CaptureStatus.Paused -> stringResource(R.string.phrases_sync_is_paused)
            CaptureStatus.Error -> stringResource(R.string.phrases_couldn_t_reach_your_devices)
        }
    val sub =
        when (status) {
            CaptureStatus.Foreground ->
                if (ui.autoCapture) {
                    stringResource(
                        R.string.phrases_android_only_lets_apps_read_the_clipboard_in_the_foreground_
                    )
                } else {
                    stringResource(R.string.product_cb_auto_off_android_p)
                }
            CaptureStatus.Offline -> stringResource(R.string.phrases_it_s_encrypted_on_this_phone_and_will_send_when_you_reconnec)
            CaptureStatus.Paused -> stringResource(R.string.phrases_nothing_is_read_or_sent_until_you_resume)
            CaptureStatus.Error -> stringResource(R.string.phrases_we_ll_retry_automatically_your_item_is_safe_on_this_phone)
        }
    Column(
        Modifier.fillMaxWidth().clip(
            RoundedCornerShape(16.dp)
        ).background(bg).padding(horizontal = 14.dp, vertical = 12.dp).testTag("clipboard.status"),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.semantics(mergeDescendants = true) {
                stateDescription =
                    status.name.lowercase()
            }
        ) {
            Icon(painterResource(icon), contentDescription = null, tint = fg, modifier = Modifier.size(20.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = fg)
                Text(sub, style = MaterialTheme.typography.bodySmall)
                Text(
                    stringResource(R.string.product_cb_bg_android),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Switch) {
                onAuto(!ui.autoCapture)
            }.testTag("clipboard.auto"),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                stringResource(R.string.product_cb_auto_android),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f)
            )
            Switch(checked = ui.autoCapture, onCheckedChange = null)
        }
        val paused = ui.snapshot.settings?.paused == true
        if (ui.snapshot.settings != null) {
            OutlinedButton(
                onClick = if (paused) onResume else onPause,
                modifier = Modifier.heightIn(min = 48.dp).testTag(if (paused) "clipboard.resume" else "clipboard.pause")
            ) {
                Text(stringResource(if (paused) R.string.product_cb_resume else R.string.product_cb_pause))
            }
        }
    }
}

@Composable
private fun ClipRow(item: ClipItem, origin: String, time: String, onOpen: () -> Unit, onCopy: () -> Unit) {
    val p = LocalSaPalette.current
    Row(
        Modifier.fillMaxWidth().clip(
            RoundedCornerShape(16.dp)
        ).background(
            if (item.incoming) p.sendSoft else p.surface
        ).padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 4.dp).testTag("clip-row"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).clickable(role = Role.Button, onClick = onOpen).padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Icon(
                painterResource(
                    if (origin ==
                        stringResource(R.string.product_cb_this_device)
                    ) {
                        R.drawable.ic_smartphone
                    } else {
                        R.drawable.ic_language
                    }
                ),
                contentDescription = null,
                tint = p.fg2,
                modifier = Modifier.size(18.dp)
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                val tags = buildList {
                    add(origin)
                    add(time)
                    if (item.pending) add(stringResource(R.string.product_cb_queued_label))
                    if (item.incoming) add(stringResource(R.string.product_cb_new))
                }
                Text(
                    tags.joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    item.text ?: stringResource(R.string.product_cb_locked_device),
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = if (item.text == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
                )
            }
        }
        if (item.text != null) {
            OutlinedButton(onClick = onCopy, modifier = Modifier.heightIn(min = 48.dp).testTag("clip.copy")) {
                Text(stringResource(R.string.android_yy_copy))
            }
        }
    }
}

/** CB-5 item sheet: origin, date and time, full text, character count, Copy, Delete (on every device). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ClipDetailSheet(item: ClipItem, origin: String, onDismiss: () -> Unit, onCopy: () -> Unit, onDelete: () -> Unit) {
    val locale = androidx.compose.ui.platform.LocalConfiguration.current.locales[0]
    val at = java.time.Instant.ofEpochMilli(item.createdAt).atZone(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM).withLocale(locale))
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("clipboard.detail")) {
        Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Text(stringResource(R.string.android_yy_cb_detail), style = MaterialTheme.typography.titleLarge)
            Text("$origin · $at", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SaCard {
                SelectionContainer {
                    Text(
                        item.text ?: stringResource(R.string.product_cb_locked_device),
                        modifier = Modifier.padding(SaTokens.Space.S4).heightIn(max = 320.dp).verticalScrollState()
                    )
                }
            }
            Text(
                listOfNotNull(
                    item.text?.let {
                        strCount(it.codePointCount(0, it.length))
                    },
                    stringResource(R.string.android_e2e)
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                if (item.text !=
                    null
                ) {
                    Button(onClick = onCopy, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("clipboard.detail.copy")) {
                        Text(stringResource(R.string.android_yy_copy))
                    }
                }
                OutlinedButton(
                    onClick = onDelete,
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("clipboard.detail.delete")
                ) {
                    Icon(painterResource(R.drawable.ic_delete), contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(" " + stringResource(R.string.android_yy_del), color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun strCount(n: Int) = str(R.string.product_cb_chars, "n" to n)

/** Paste fallback: Android did not share the clipboard (the window had no focus yet). */
@Composable
private fun PasteDialog(onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.product_cb_paste_h)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                Text(stringResource(R.string.product_cb_paste_p_android))
                OutlinedTextField(text, {
                    text = it
                }, label = {
                    Text(stringResource(R.string.product_cb_paste_label))
                }, minLines = 3, modifier = Modifier.fillMaxWidth().testTag("clipboard.paste"))
            }
        },
        confirmButton = {
            TextButton(enabled = text.isNotBlank(), onClick = { onSend(text) }) { Text(stringResource(R.string.product_cb_paste_send)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.android_cancel)) } }
    )
}
