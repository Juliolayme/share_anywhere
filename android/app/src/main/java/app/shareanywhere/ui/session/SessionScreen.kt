package app.shareanywhere.ui.session

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.data.api.Participant
import app.shareanywhere.data.api.SessionView
import app.shareanywhere.qr.QrCode
import app.shareanywhere.sharing.LIVE_STATUSES
import app.shareanywhere.sharing.mmss
import app.shareanywhere.sharing.secondsUntil
import app.shareanywhere.transfer.runtime.active
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.FlowTopBar
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.components.SwitchRow
import app.shareanywhere.ui.components.Tone
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.keepawake.KeepOpenBanner
import app.shareanywhere.ui.keepawake.rememberKeepAwake
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.sharing.ParticipantCard
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens
import app.shareanywhere.ui.transfer.chip
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Seconds of the local clock, ticking once a second while the screen is shown. */
@Composable
fun rememberNow(): Long {
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(1000)
            value = System.currentTimeMillis()
        }
    }
    return now
}

/**
 * TR-4/TR-5 design screens `session` and `session-expired`: QR, six-digit code and link sharing one 10:00 join
 * window, Create new code once it ends, Session full, Require approval, receivers with security words, Remove and
 * Block, join requests with Approve/Reject, Stop accepting, protected-mode notice, and Close (TR-8 sheet). The screen
 * stays on while the join window is open (docs/ARCHITECTURE.md §7.1).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
    onExit: () -> Unit,
    onNewSession: () -> Unit,
    onTurnKeepScreenOn: () -> Unit,
    onOpenDashboard: () -> Unit,
    viewModel: SessionViewModel = hiltViewModel()
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val sender by viewModel.sender.collectAsStateWithLifecycle()
    val tx = sender?.state?.collectAsStateWithLifecycle()?.value
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val now = rememberNow()
    var confirmClose by rememberSaveable { mutableStateOf(false) }
    var blockTarget by remember { mutableStateOf<Participant?>(null) }

    LaunchedEffect(viewModel) {
        viewModel.messages.collect { m ->
            snackbar.showSnackbar(context.getString(m.id).let { t -> app.shareanywhere.ui.i18n.formatTemplate(t, m.args) })
        }
    }
    // Ask for notifications just in time, so a join while the app is in the background can be announced (ON-3).
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    val view = ui.view
    val live = view != null && view.status in LIVE_STATUSES
    val win = view?.joinWindow
    val left = if (win != null) secondsUntil(win.endsAt, ui.offset, now) else 0
    val windowOpen = live && win?.state == "OPEN" && left > 0
    // The countdown reached zero: reload so the expired state comes from the server.
    LaunchedEffect(live, win?.state, left == 0L) {
        if (live && win?.state == "OPEN" && left == 0L) {
            delay(1200)
            viewModel.load()
        }
    }
    val transferring = tx?.receivers?.any { it.status.active() } == true
    // The screen stays on while the join window is open or transfers run (docs/ARCHITECTURE.md §7.1).
    val pill = rememberKeepAwake(needs = windowOpen || transferring)

    val screenId = if (windowOpen) ScreenIds.SESSION else ScreenIds.SESSION_EXPIRED
    Column(Modifier.fillMaxSize().testTag(screenId)) {
        FlowTopBar(
            stringResource(R.string.android_share_h),
            R.drawable.ic_close,
            stringResource(R.string.android_close),
            onNav = { if (live) confirmClose = true else onExit() },
            trailing = {
                if (windowOpen) {
                    Row(
                        Modifier
                            .padding(end = SaTokens.Space.S3)
                            .clip(CircleShape)
                            .background(LocalSaPalette.current.surface2)
                            .padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S1),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)
                    ) {
                        Icon(painterResource(R.drawable.ic_timer), contentDescription = null, modifier = Modifier.size(SaTokens.Space.S4))
                        Text(mmss(left), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
        )
        when {
            view == null && ui.loadError == LoadError.NotFound -> Ended(
                stringResource(R.string.product_session_expired_s),
                onNewSession,
                onExit
            )
            view == null ->
                Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                    if (ui.loadError == LoadError.Failed) {
                        InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_error_generic), action = {
                            TextButton(onClick = viewModel::load) { Text(stringResource(R.string.common_retry)) }
                        })
                    }
                    app.shareanywhere.ui.components.SkeletonList(3, stringResource(R.string.android_share_h))
                }
            !live ->
                Ended(
                    stringResource(if (view.status == "CLOSED") R.string.product_session_closed else R.string.product_session_expired_s),
                    onNewSession,
                    onExit
                )
            else ->
                Live(
                    view = view,
                    showKeep = windowOpen || transferring,
                    tx = tx,
                    onOpenDashboard = onOpenDashboard,
                    windowOpen = windowOpen,
                    left = left,
                    busy = ui.busy,
                    pill = pill,
                    onTurnKeepScreenOn = onTurnKeepScreenOn,
                    vm = viewModel,
                    onCopy = { _, text ->
                        clipboard.setText(AnnotatedString(text))
                        scope.launch { snackbar.showSnackbar(context.getString(R.string.common_n_copied)) }
                    },
                    onShare = { url ->
                        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
                        context.startActivity(Intent.createChooser(send, null))
                    },
                    onBlock = { blockTarget = it }
                )
        }
    }

    if (confirmClose) {
        ModalBottomSheet(onDismissRequest = { confirmClose = false }, modifier = Modifier.testTag("session.close-sheet")) {
            Column(
                Modifier.padding(horizontal = SaTokens.Space.S6).padding(bottom = SaTokens.Space.S6),
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
            ) {
                Text(
                    stringResource(R.string.product_close_h),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.semantics {
                        heading()
                    }
                )
                Text(
                    stringResource(R.string.product_close_p),
                    style = MaterialTheme.typography.bodyMedium,
                    color = LocalSaPalette.current.fg2
                )
                PrimaryButton(stringResource(R.string.android_close), {
                    confirmClose = false
                    viewModel.close()
                }, tone = Tone.Danger, busy = ui.busy == "close", modifier = Modifier.testTag("session.close-confirm"))
                SecondaryButton(stringResource(R.string.common_cancel), { confirmClose = false }, Modifier.fillMaxWidth())
            }
        }
    }
    blockTarget?.let { p ->
        ConfirmDialog(
            title = stringResource(R.string.product_block_confirm_h),
            body = stringResource(R.string.product_block_confirm_p),
            confirm = stringResource(R.string.product_block),
            onConfirm = {
                blockTarget = null
                viewModel.block(p)
            },
            onDismiss = { blockTarget = null }
        )
    }
}

@Composable
private fun Ended(title: String, onNewSession: () -> Unit, onExit: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(SaTokens.Space.S6).testTag("session.ended"),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S4)
    ) {
        Icon(
            painterResource(R.drawable.ic_timer_off),
            contentDescription = null,
            tint = LocalSaPalette.current.fg2,
            modifier = Modifier.size(SaTokens.Space.S12)
        )
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
        PrimaryButton(stringResource(R.string.product_new_session), onNewSession)
        SecondaryButton(stringResource(R.string.product_back_home), onExit, Modifier.fillMaxWidth())
    }
}

@Composable
private fun Live(
    view: SessionView,
    showKeep: Boolean,
    tx: app.shareanywhere.transfer.runtime.TxState?,
    onOpenDashboard: () -> Unit,
    windowOpen: Boolean,
    left: Long,
    busy: String?,
    pill: app.shareanywhere.ui.keepawake.PillState,
    onTurnKeepScreenOn: () -> Unit,
    vm: SessionViewModel,
    onCopy: (String, String) -> Unit,
    onShare: (String) -> Unit,
    onBlock: (Participant) -> Unit
) {
    val p = LocalSaPalette.current
    val cap = view.capacity ?: app.shareanywhere.data.api.Capacity(0, 0, 5)
    val taken = cap.joined + cap.requested
    val full = taken >= cap.max
    val receivers = view.participants.orEmpty().filter { it.status == "JOINED" || it.status == "REQUESTED" }
    val requests = receivers.filter { it.status == "REQUESTED" }
    val joined = receivers.filter { it.status == "JOINED" }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        if (showKeep) KeepOpenBanner(pill, onTurnKeepScreenOn)
        if (view.protectedMode) {
            InlineNotice(
                NoticeKind.Warning,
                R.drawable.ic_shield,
                stringResource(R.string.product_protected_mode_sender)
            )
        }
        if (windowOpen && cap.joined > 0) {
            InlineNotice(NoticeKind.Info, R.drawable.ic_lock, stringResource(R.string.product_stop_nudge), action = {
                TextButton(onClick = vm::stopAccepting, enabled = busy == null) { Text(stringResource(R.string.product_stop_accepting)) }
            })
        }
        SaCard(Modifier.testTag("session.share")) {
            Column(
                Modifier.fillMaxWidth().padding(SaTokens.Space.S4),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
            ) {
                val code = view.code
                val url = view.joinUrl
                if (windowOpen && code != null && url != null) {
                    val codeAria = str(R.string.product_code_aria, "code" to code.toList().joinToString(" "))
                    QrCode(url, stringResource(R.string.product_qr_aria))
                    Text(stringResource(R.string.android_code), style = MaterialTheme.typography.labelLarge, color = p.fg2)
                    Text(
                        code.take(3) + " " + code.drop(3),
                        style = MaterialTheme.typography.displaySmall,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.testTag("session-code").semantics { contentDescription = codeAria }
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                        SecondaryButton(stringResource(R.string.android_copy), {
                            onCopy("code", code)
                        }, icon = R.drawable.ic_content_copy, modifier = Modifier.testTag("session.copy"))
                        SecondaryButton(stringResource(R.string.android_share), {
                            onShare(url)
                        }, icon = R.drawable.ic_share, modifier = Modifier.testTag("session.share-link"))
                    }
                    Row(
                        Modifier.fillMaxWidth().clip(
                            RoundedCornerShape(SaTokens.Radius.Md)
                        ).background(p.surface2).padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S1),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_timer),
                            contentDescription = null,
                            tint = p.fg2,
                            modifier = Modifier.size(SaTokens.Space.S4)
                        )
                        Text(
                            stringResource(R.string.common_cx_valid) + " · " + mmss(left),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (left <= 60) p.warningInk else p.fg2,
                            modifier = Modifier.weight(1f).testTag("countdown")
                        )
                        TextButton(onClick = vm::stopAccepting, enabled = busy == null, modifier = Modifier.testTag("session.stop")) {
                            Text(stringResource(R.string.product_stop_accepting))
                        }
                    }
                    ExpiryAnnouncer(left)
                } else if (view.joinWindow?.state == "ENDED_FULL" && full) {
                    Column(
                        Modifier.fillMaxWidth().semantics {
                            liveRegion = LiveRegionMode.Polite
                        },
                        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
                    ) {
                        Icon(painterResource(R.drawable.ic_lock), contentDescription = null, tint = p.fg2)
                        Text(stringResource(R.string.product_capacity_full), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.product_session_full_s), style = MaterialTheme.typography.bodySmall, color = p.fg2)
                    }
                } else {
                    Column(
                        Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive }.testTag("code-expired"),
                        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
                    ) {
                        Icon(painterResource(R.drawable.ic_timer_off), contentDescription = null, tint = p.warningInk)
                        Text(
                            stringResource(
                                if (view.joinWindow?.state ==
                                    "ENDED_BY_SENDER"
                                ) {
                                    R.string.product_not_accepting_s
                                } else {
                                    R.string.common_cx_h
                                }
                            ),
                            style = MaterialTheme.typography.titleMedium
                        )
                        Text(stringResource(R.string.common_cx_p), style = MaterialTheme.typography.bodySmall, color = p.fg2)
                        PrimaryButton(
                            stringResource(R.string.common_cx_btn),
                            vm::renew,
                            enabled = !full,
                            busy = busy == "renew",
                            modifier = Modifier.testTag("session.renew")
                        )
                    }
                }
            }
        }
        SaCard {
            SwitchRow(
                label = stringResource(R.string.android_reqappr),
                checked = view.requireApproval,
                onCheckedChange = vm::setRequireApproval,
                description = stringResource(if (view.requireApproval) R.string.product_appr_on else R.string.product_appr_off),
                modifier = Modifier.testTag("session.approval")
            )
        }
        Row(Modifier.fillMaxWidth().padding(top = SaTokens.Space.S2), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.android_receivers) + " · $taken/${cap.max}",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f).semantics { heading() }
            )
            Text(
                if (full) stringResource(R.string.product_capacity_full) else str(R.string.product_slots_left, "n" to cap.max - taken),
                style = MaterialTheme.typography.bodySmall,
                color = p.fg2,
                modifier = Modifier.testTag("slots")
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
            repeat(cap.max) { i ->
                Box(
                    Modifier
                        .weight(1f)
                        .height(SaTokens.Space.S1 + SaTokens.Space.S1 / 2)
                        .clip(CircleShape)
                        .background(
                            if (i < cap.joined) {
                                p.receive
                            } else if (i < taken) {
                                p.warning
                            } else {
                                p.track
                            }
                        )
                )
            }
        }
        (requests + joined).forEach { r ->
            ParticipantCard(
                r,
                busy = busy == r.id,
                onApprove = { vm.approve(r) },
                onReject = { vm.reject(r) },
                onRemove = { vm.remove(r) },
                onBlock = { onBlock(r) }
            ) {
                tx?.receivers?.firstOrNull { it.participantId == r.id }?.let { TransferLine(it) }
            }
        }
        if (joined.isNotEmpty()) {
            PrimaryButton(
                stringResource(R.string.product_view_dashboard),
                onOpenDashboard,
                Modifier.testTag("session.dashboard")
            )
        }
        if (receivers.isEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(SaTokens.Radius.Lg))
                    .border(SaTokens.Border.Thin, p.borderStrong, RoundedCornerShape(SaTokens.Radius.Lg))
                    .padding(SaTokens.Space.S4)
                    .testTag("no-receivers"),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)
            ) {
                Text(stringResource(R.string.android_waiting_r), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(if (view.requireApproval) R.string.product_empty_receivers_appr else R.string.product_empty_receivers),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.fg2
                )
            }
        }
        Spacer(Modifier.heightIn(min = SaTokens.Space.S4))
    }
}

/** Announces "Code expires in m:ss" to TalkBack at one minute and ten seconds left (as the Web's ExpiryAnnouncer). */
@Composable
private fun ExpiryAnnouncer(left: Long) {
    val text =
        when {
            left in 1..10 -> str(R.string.product_code_expires_in, "time" to mmss(10))
            left in 11..60 -> str(R.string.product_code_expires_in, "time" to mmss(60))
            else -> ""
        }
    Text(
        text,
        modifier = Modifier.size(SaTokens.Border.Thin).semantics {
            liveRegion = LiveRegionMode.Polite
        },
        maxLines = 1,
        overflow = TextOverflow.Clip
    )
}

/** A joined receiver's transfer at a glance (full detail on the dashboard). */
@Composable
private fun TransferLine(r: app.shareanywhere.transfer.runtime.TxReceiver) {
    val p = LocalSaPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1), modifier = Modifier.testTag("participant-transfer")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            app.shareanywhere.ui.transfer.StatusChip(r.status.chip(), Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(1f))
            Text(
                when (r.status) {
                    app.shareanywhere.transfer.runtime.TxStatus.Waiting -> stringResource(R.string.product_transfer_waiting)
                    app.shareanywhere.transfer.runtime.TxStatus.Offline -> stringResource(R.string.product_transfer_offline)
                    else -> app.shareanywhere.ui.transfer.percent(r.verified, r.total)
                },
                style = MaterialTheme.typography.bodySmall,
                color = p.fg2
            )
        }
        app.shareanywhere.ui.transfer.ProgressLine(
            if (r.total >
                0
            ) {
                r.verified.toFloat() / r.total
            } else {
                0f
            },
            r.name,
            height = SaTokens.Space.S1
        )
    }
}
