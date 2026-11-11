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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import app.shareanywhere.sharing.mmss
import app.shareanywhere.sharing.secondsUntil
import app.shareanywhere.ui.components.FlowTopBar
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.components.Tone
import app.shareanywhere.ui.format.formatBytes
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.session.rememberNow
import app.shareanywhere.ui.sharing.IdentityBadge
import app.shareanywhere.ui.sharing.platformIcon
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

/**
 * RX-4 design screen `rx-preview` ("Incoming files"): sender with Guest/Signed in badge, the files and total,
 * "Join within m:ss" in the window's last minute, the expired state, and Receive. With approval on (or protected
 * mode) the receiver is told it will wait for the sender.
 */
@Composable
fun JoinPreviewScreen(onBack: () -> Unit, onJoined: (String) -> Unit, viewModel: JoinPreviewViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val p = LocalSaPalette.current
    val locale = LocalConfiguration.current.uiLocale()
    val now = rememberNow()
    LaunchedEffect(viewModel) { viewModel.joined.collect(onJoined) }
    val pending = ui.pending
    if (pending == null) {
        // Process death or a stale back stack entry: nothing to preview, go back to Receive.
        LaunchedEffect(Unit) { onBack() }
        return
    }
    val preview = pending.preview
    val left = secondsUntil(preview.joinWindowEndsAt, pending.offset, now)
    val expired = left == 0L
    Column(Modifier.fillMaxSize().testTag(ScreenIds.RX_PREVIEW)) {
        FlowTopBar(
            stringResource(R.string.product_rx_incoming),
            R.drawable.ic_arrow_back,
            stringResource(R.string.product_change_code),
            onBack
        )
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
        ) {
            Text(
                if (preview.fileCount == 1) {
                    str(R.string.product_preview_title_one, "name" to preview.sender.displayName)
                } else {
                    str(R.string.product_preview_title, "name" to preview.sender.displayName, "n" to preview.fileCount)
                },
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() }
            )
            SaCard {
                Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                        Box(
                            Modifier.size(SaTokens.Space.S12).clip(RoundedCornerShape(SaTokens.Radius.Md)).background(p.surface2),
                            contentAlignment = Alignment.Center
                        ) { Icon(painterResource(platformIcon(preview.sender.platform)), contentDescription = null, tint = p.fg2) }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    preview.sender.displayName,
                                    style = MaterialTheme.typography.titleSmall,
                                    modifier = Modifier.testTag("preview-sender")
                                )
                                IdentityBadge(preview.sender.signedIn)
                            }
                            Text(
                                str(R.string.product_rx_sender_line, "platform" to preview.sender.platform, "time" to mmss(left)),
                                style = MaterialTheme.typography.bodySmall,
                                color = p.fg2
                            )
                        }
                    }
                    preview.files.forEach { f ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
                        ) {
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
                    HorizontalDivider(color = p.border)
                    Row {
                        Text(
                            stringResource(R.string.android_total),
                            style = MaterialTheme.typography.titleSmall,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            formatBytes(preview.totalBytes, locale),
                            style = MaterialTheme.typography.titleSmall,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                Icon(
                    painterResource(R.drawable.ic_verified_user),
                    contentDescription = null,
                    tint = p.receiveInk,
                    modifier = Modifier.size(SaTokens.Space.S4)
                )
                Text(stringResource(R.string.product_preview_secure), style = MaterialTheme.typography.bodySmall, color = p.fg2)
            }
            if (preview.protectedMode || preview.requireApproval) {
                InlineNotice(
                    NoticeKind.Warning,
                    R.drawable.ic_hourglass_top,
                    stringResource(if (preview.protectedMode) R.string.product_protected_mode else R.string.product_waiting_sender)
                )
            }
            ui.error?.let {
                InlineNotice(
                    NoticeKind.Error,
                    R.drawable.ic_error,
                    str(it.id, *it.args.toList().toTypedArray()),
                    Modifier.testTag("preview.error")
                )
            }
            if (expired) {
                InlineNotice(
                    NoticeKind.Warning,
                    R.drawable.ic_timer_off,
                    stringResource(R.string.common_cx_rx),
                    Modifier.testTag("preview.expired")
                )
            }
        }
        Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
            if (expired) {
                SecondaryButton(stringResource(R.string.product_another_code), onBack, Modifier.fillMaxWidth())
            } else {
                PrimaryButton(
                    stringResource(if (ui.joining) R.string.product_joining else R.string.product_receive_cta),
                    viewModel::join,
                    Modifier.testTag("preview.receive"),
                    tone = Tone.Receive,
                    busy = ui.joining
                )
                if (left <= 60) {
                    Text(
                        str(R.string.product_join_within, "time" to mmss(left)),
                        style = MaterialTheme.typography.bodySmall,
                        color = p.fg2,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().testTag("join-within")
                    )
                }
            }
        }
    }
}

/** RX-3: an App Link being resolved (no Welcome screen in front of it, as on the Web). */
@Composable
fun JoinLinkScreen(token: String, onBack: () -> Unit, onNav: (ReceiveNav) -> Unit, viewModel: ReceiveViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    LaunchedEffect(viewModel) { viewModel.nav.collect(onNav) }
    LaunchedEffect(token) { viewModel.openToken(token) }
    Column(Modifier.fillMaxSize().testTag("join-link")) {
        FlowTopBar(stringResource(R.string.android_receive), R.drawable.ic_arrow_back, stringResource(R.string.product_back), onBack)
        Column(
            Modifier.fillMaxWidth().padding(SaTokens.Space.S6),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S4)
        ) {
            val err = ui.error
            if (err == null) {
                CircularProgressIndicator()
                Text(stringResource(R.string.product_opening_link), style = MaterialTheme.typography.bodyMedium)
            } else {
                InlineNotice(NoticeKind.Error, R.drawable.ic_error, str(err.id, *err.args.toList().toTypedArray()))
                SecondaryButton(stringResource(R.string.product_another_code), onBack, Modifier.fillMaxWidth())
            }
        }
    }
}
