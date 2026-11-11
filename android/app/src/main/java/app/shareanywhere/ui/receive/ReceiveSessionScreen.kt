package app.shareanywhere.ui.receive

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.data.api.SessionView
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.components.Tone
import app.shareanywhere.ui.format.formatBytes
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.keepawake.KeepOpenBanner
import app.shareanywhere.ui.keepawake.rememberKeepAwake
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.sharing.SecurityWords
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

/**
 * Receiver side of a session: RX-5 `rx-wait` while the sender decides (screen kept on, keep-open banner), the joined
 * receiver (`rx-save`: sender, security words, the files; choosing a folder and receiving arrive with the transfer
 * engine in milestone 6.3) and the RX-7 `rx-done` outcomes (removed, blocked, left, closed, ended) or the declined
 * request on `rx-wait`.
 */
@Composable
fun ReceiveSessionScreen(onAnotherCode: () -> Unit, onTurnKeepScreenOn: () -> Unit, viewModel: ReceiveSessionViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val device by viewModel.deviceName.collectAsStateWithLifecycle(initialValue = null)
    LaunchedEffect(viewModel) { viewModel.left.collect { onAnotherCode() } }
    val pill = rememberKeepAwake(needs = ui.waiting)
    val outcome = ui.outcome
    val view = ui.view
    when {
        outcome != null -> OutcomeView(outcome, onAnotherCode)
        view == null ->
            Column(
                Modifier.fillMaxSize().padding(SaTokens.Space.S4).testTag(ScreenIds.RX_WAIT),
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
            ) {
                if (ui.failed) {
                    InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_error_generic), action = {
                        TextButton(onClick = viewModel::load) { Text(stringResource(R.string.common_retry)) }
                    })
                }
                SkeletonList(3, stringResource(R.string.android_waiting))
            }
        ui.waiting -> Waiting(view, device, pill, onTurnKeepScreenOn, ui.leaving, ui.leaveFailed, viewModel::leave)
        else -> Joined(view, ui.leaving, ui.leaveFailed, viewModel::leave)
    }
}

@Composable
private fun Centered(tag: String, icon: Int, iconBg: Color, iconFg: Color, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SaTokens.Space.S6).testTag(tag),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3, Alignment.CenterVertically)
    ) {
        Box(
            Modifier.size(SaTokens.Space.S16 + SaTokens.Space.S4).clip(CircleShape).background(iconBg),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(icon),
                contentDescription = null,
                tint = iconFg,
                modifier = Modifier.size(
                    SaTokens.Space.S8 + SaTokens.Space.S2
                )
            )
        }
        content()
    }
}

@Composable
private fun Waiting(
    view: SessionView,
    device: String?,
    pill: app.shareanywhere.ui.keepawake.PillState,
    onTurnKeepScreenOn: () -> Unit,
    leaving: Boolean,
    leaveFailed: Boolean,
    onCancel: () -> Unit
) {
    val p = LocalSaPalette.current
    val sender = view.sender?.displayName.orEmpty()
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S1)) { KeepOpenBanner(pill, onTurnKeepScreenOn) }
        Box(Modifier.weight(1f)) {
            Centered(ScreenIds.RX_WAIT, R.drawable.ic_hourglass_top, p.warningSoft, p.warningInk) {
                Text(
                    stringResource(R.string.android_waiting),
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.semantics {
                        heading()
                    }
                )
                Text(
                    str(R.string.product_waiting_body_app, "name" to sender, "device" to (device ?: view.me?.displayName.orEmpty())),
                    style = MaterialTheme.typography.bodyMedium,
                    color = p.fg2,
                    textAlign = TextAlign.Center
                )
                SecurityWords(view.me?.securityWords, stringResource(R.string.android_xx_secw_r))
                if (leaveFailed) InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_leave_failed))
                SecondaryButton(
                    stringResource(R.string.android_cancel),
                    onCancel,
                    Modifier.fillMaxWidth().testTag("rx.cancel"),
                    enabled = !leaving
                )
            }
        }
    }
}

@Composable
private fun Joined(view: SessionView, leaving: Boolean, leaveFailed: Boolean, onLeave: () -> Unit) {
    val p = LocalSaPalette.current
    val locale = LocalConfiguration.current.uiLocale()
    val sender = view.sender?.displayName.orEmpty()
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SaTokens.Space.S4).testTag(ScreenIds.RX_SAVE),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Text(
            str(R.string.product_joined_session, "name" to sender),
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.semantics {
                heading()
            }
        )
        SecurityWords(view.me?.securityWords, stringResource(R.string.android_xx_secw_r))
        SaCard {
            Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                view.files.orEmpty().forEach { f ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                        Icon(
                            painterResource(R.drawable.ic_description),
                            contentDescription = null,
                            tint = p.fg2,
                            modifier = Modifier.size(
                                SaTokens.Space.S4 + SaTokens.Space.S1
                            )
                        )
                        Text(
                            f.name,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            formatBytes(f.size, locale),
                            style = MaterialTheme.typography.bodySmall,
                            color = p.fg2,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }
                Row {
                    Text(
                        stringResource(R.string.android_total),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f)
                    )
                    Text(
                        formatBytes(view.totalBytes, locale),
                        style = MaterialTheme.typography.titleSmall,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }
        }
        InlineNotice(NoticeKind.Info, R.drawable.ic_info, stringResource(R.string.product_files_pending))
        if (leaveFailed) InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_leave_failed))
        SecondaryButton(stringResource(R.string.product_leave), onLeave, Modifier.fillMaxWidth().testTag("rx.leave"), enabled = !leaving)
    }
}

@Composable
private fun OutcomeView(outcome: Outcome, onAnotherCode: () -> Unit) {
    val p = LocalSaPalette.current
    val (title, body) =
        when (outcome) {
            Outcome.Removed -> R.string.product_removed_rx to null
            Outcome.Blocked -> R.string.product_blocked_rx to null
            Outcome.Rejected -> R.string.product_declined_h to R.string.product_declined_p
            Outcome.Left -> R.string.product_left_rx to null
            Outcome.Closed -> R.string.product_closed_rx to null
            Outcome.Ended -> R.string.product_session_ended_rx to null
        }
    val tag = if (outcome == Outcome.Rejected) ScreenIds.RX_WAIT else ScreenIds.RX_DONE
    val icon = if (outcome == Outcome.Closed || outcome == Outcome.Ended) R.drawable.ic_timer_off else R.drawable.ic_block
    Centered(tag, icon, p.surface2, p.fg2) {
        Text(
            stringResource(title),
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics {
                heading()
            }.testTag("rx.outcome")
        )
        if (body !=
            null
        ) {
            Text(stringResource(body), style = MaterialTheme.typography.bodyMedium, color = p.fg2, textAlign = TextAlign.Center)
        }
        PrimaryButton(stringResource(R.string.product_another_code), onAnotherCode, tone = Tone.Receive)
    }
}
