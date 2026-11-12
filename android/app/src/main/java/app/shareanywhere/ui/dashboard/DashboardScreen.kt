package app.shareanywhere.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.transfer.runtime.SessionResult
import app.shareanywhere.transfer.runtime.TxFinal
import app.shareanywhere.transfer.runtime.TxReceiver
import app.shareanywhere.transfer.runtime.TxState
import app.shareanywhere.transfer.runtime.TxStatus
import app.shareanywhere.transfer.runtime.active
import app.shareanywhere.transfer.runtime.ended
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.FlowTopBar
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.format.formatBytes
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.keepawake.KeepOpenBanner
import app.shareanywhere.ui.keepawake.rememberKeepAwake
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.sharing.platformIcon
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens
import app.shareanywhere.ui.transfer.ProgressLine
import app.shareanywhere.ui.transfer.RouteChip
import app.shareanywhere.ui.transfer.StatusChip
import app.shareanywhere.ui.transfer.chip
import app.shareanywhere.ui.transfer.errorRes
import app.shareanywhere.ui.transfer.etaText
import app.shareanywhere.ui.transfer.percent

/**
 * TR-6 `dashboard` and TR-7 `dashboard-done` / `dashboard-partial`: overall progress, one card per receiver with route,
 * status, progress, ETA, Pause/Resume, Retry hint and Remove; Stop all with confirmation; the result once every
 * receiver ended. The screen stays on while any transfer runs.
 */
@Composable
fun DashboardScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    onTurnKeepScreenOn: () -> Unit,
    viewModel: DashboardViewModel = hiltViewModel()
) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val p = LocalSaPalette.current
    val locale = LocalConfiguration.current.uiLocale()
    var confirmStop by rememberSaveable { mutableStateOf(false) }
    val running = s.receivers.any { it.status.active() }
    val pill = rememberKeepAwake(needs = running && s.hasFiles)
    val final = s.final
    val tag =
        when (final) {
            TxFinal.Completed -> ScreenIds.DASHBOARD_DONE
            TxFinal.Partial -> ScreenIds.DASHBOARD_PARTIAL
            else -> ScreenIds.DASHBOARD
        }
    val counted = s.receivers.filter { !it.status.ended() || it.status == TxStatus.Completed }
    Column(Modifier.fillMaxSize().testTag(tag)) {
        FlowTopBar(
            str(R.string.product_dashboard_h, "n" to s.receivers.count { it.joined }),
            R.drawable.ic_arrow_back,
            stringResource(R.string.product_back),
            onBack,
            trailing = {
                if (final == null && s.receivers.any { !it.status.ended() }) {
                    TextButton(onClick = {
                        confirmStop = true
                    }, modifier = Modifier.testTag("dashboard.stop-all")) {
                        Text(stringResource(R.string.product_stop_all), color = p.dangerInk)
                    }
                }
            }
        )
        if (!s.loaded) return@Column Box(Modifier.padding(SaTokens.Space.S4)) { SkeletonList(3, stringResource(R.string.android_overall)) }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
        ) {
            if (running) {
                KeepOpenBanner(pill, onTurnKeepScreenOn)
                Text(stringResource(R.string.product_hint_android_screen_off), style = MaterialTheme.typography.bodySmall, color = p.fg2)
            }
            if (!s.hasFiles) InlineNotice(NoticeKind.Warning, R.drawable.ic_error, stringResource(R.string.product_tx_err_files_gone_app))
            if (final != null) Result(final, s)
            val verified = counted.sumOf { it.verified }
            val total = counted.sumOf { it.total }
            SaCard {
                Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(
                            percent(verified, total),
                            style = MaterialTheme.typography.headlineSmall,
                            modifier = Modifier.testTag("dashboard.percent")
                        )
                        Text("  " + stringResource(R.string.android_overall), style = MaterialTheme.typography.bodySmall, color = p.fg2)
                    }
                    ProgressLine(if (total > 0) verified.toFloat() / total else 0f, stringResource(R.string.android_overall))
                    val eta = SessionResult.groupEta(s.receivers)
                    if (eta != -1L) Text(etaText(eta), style = MaterialTheme.typography.bodySmall, color = p.fg2)
                }
            }
            s.receivers.forEach { r ->
                ReceiverCard(r, locale, onPause = {
                    viewModel.pause(r.participantId)
                }, onResume = { viewModel.resume(r.participantId) }, onCancel = { viewModel.cancel(r.participantId) })
            }
        }
        if (final != null) {
            PrimaryButton(stringResource(R.string.android_yy_done), {
                viewModel.done()
                onDone()
            }, Modifier.padding(SaTokens.Space.S4).testTag("dashboard.done"))
        }
    }
    if (confirmStop) {
        ConfirmDialog(
            title = stringResource(R.string.product_stopall_h),
            body = stringResource(R.string.product_stopall_p),
            confirm = stringResource(R.string.product_stop_all),
            onConfirm = {
                confirmStop = false
                viewModel.stopAll()
            },
            onDismiss = { confirmStop = false }
        )
    }
}

@Composable
private fun Result(final: TxFinal, s: TxState) {
    val p = LocalSaPalette.current
    val (icon, label, bg, fg) =
        when (final) {
            TxFinal.Completed -> listOf(R.drawable.ic_check_circle, R.string.android_lbl_completed, p.receiveSoft, p.receiveInk)
            TxFinal.Partial -> listOf(R.drawable.ic_incomplete_circle, R.string.android_lbl_partial, p.warningSoft, p.warningInk)
            TxFinal.Failed -> listOf(R.drawable.ic_error, R.string.android_lbl_failed, p.dangerSoft, p.dangerInk)
            TxFinal.Cancelled -> listOf(R.drawable.ic_cancel, R.string.android_lbl_cancelled, p.surface2, p.fg2)
        }
    Row(
        Modifier.fillMaxWidth().clip(
            RoundedCornerShape(SaTokens.Radius.Lg)
        ).background(bg as androidx.compose.ui.graphics.Color).padding(SaTokens.Space.S4).testTag("dashboard.result"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Icon(painterResource(icon as Int), contentDescription = null, tint = fg as androidx.compose.ui.graphics.Color)
        Text(
            stringResource(label as Int),
            style = MaterialTheme.typography.titleMedium,
            color = fg,
            modifier = Modifier.semantics {
                heading()
            }
        )
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ReceiverCard(r: TxReceiver, locale: java.util.Locale, onPause: () -> Unit, onResume: () -> Unit, onCancel: () -> Unit) {
    val p = LocalSaPalette.current
    val shape = RoundedCornerShape(SaTokens.Radius.Lg)
    Column(
        Modifier.fillMaxWidth().clip(
            shape
        ).background(MaterialTheme.colorScheme.surface).border(SaTokens.Border.Thin, p.border, shape).padding(SaTokens.Space.S3).semantics {
            contentDescription =
                r.name
        }.testTag("dashboard.receiver"),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Icon(
                painterResource(platformIcon(r.platform)),
                contentDescription = null,
                tint = p.fg2,
                modifier = Modifier.size(SaTokens.Space.S6)
            )
            Column(Modifier.weight(1f)) {
                Text(r.name, style = MaterialTheme.typography.titleSmall)
                RouteChip(r.route, kind = r.routeKind)
            }
            StatusChip(r.status.chip(), Modifier.testTag("dashboard.status"))
        }
        Row {
            Text(percent(r.verified, r.total), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            val meta =
                when (r.status) {
                    TxStatus.Waiting -> stringResource(R.string.product_transfer_waiting)
                    TxStatus.Offline -> stringResource(R.string.product_transfer_offline)
                    else ->
                        if (r.status.active()) {
                            (
                                if (r.bytesPerSecond >
                                    0
                                ) {
                                    str(R.string.product_per_second, "size" to formatBytes(r.bytesPerSecond.toLong(), locale)) + " · "
                                } else {
                                    ""
                                }
                                ) +
                                etaText(r.eta)
                        } else {
                            "${formatBytes(r.verified, locale)} / ${formatBytes(r.total, locale)}"
                        }
                }
            Text(meta, style = MaterialTheme.typography.bodySmall, color = p.fg2)
        }
        ProgressLine(
            if (r.total >
                0
            ) {
                r.verified.toFloat() / r.total
            } else {
                0f
            },
            r.name,
            tone = if (r.status ==
                TxStatus.Completed
            ) {
                p.receive
            } else if (r.status == TxStatus.Failed) {
                p.danger
            } else {
                p.send
            }
        )
        r.error?.let { Text(stringResource(errorRes(it)), style = MaterialTheme.typography.bodySmall, color = p.dangerInk) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
            if (r.status.active()) {
                TextButton(onClick = onPause, modifier = Modifier.testTag("dashboard.pause")) {
                    Icon(painterResource(R.drawable.ic_pause), contentDescription = null, modifier = Modifier.size(SaTokens.Space.S4))
                    Text(" " + stringResource(R.string.android_pause))
                }
            }
            if (r.status == TxStatus.Paused) {
                TextButton(onClick = onResume, modifier = Modifier.testTag("dashboard.resume")) {
                    Icon(painterResource(R.drawable.ic_play_arrow), contentDescription = null, modifier = Modifier.size(SaTokens.Space.S4))
                    Text(" " + stringResource(R.string.android_resume))
                }
            }
            if (!r.status.ended()) {
                TextButton(onClick = onCancel, modifier = Modifier.testTag("dashboard.cancel")) {
                    Icon(
                        painterResource(R.drawable.ic_stop_circle),
                        contentDescription = null,
                        tint = p.dangerInk,
                        modifier = Modifier.size(SaTokens.Space.S4)
                    )
                    Text(" " + stringResource(R.string.android_cancel), color = p.dangerInk)
                }
            }
        }
    }
}
