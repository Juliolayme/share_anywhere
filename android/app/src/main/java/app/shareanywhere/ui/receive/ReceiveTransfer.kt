package app.shareanywhere.ui.receive

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.core.net.toUri
import app.shareanywhere.R
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.transfer.runtime.RxState
import app.shareanywhere.transfer.runtime.active
import app.shareanywhere.transfer.storage.Folders
import app.shareanywhere.ui.components.ConfirmDialog
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
import app.shareanywhere.ui.transfer.ProgressLine
import app.shareanywhere.ui.transfer.RouteChip
import app.shareanywhere.ui.transfer.StatusChip
import app.shareanywhere.ui.transfer.chip
import app.shareanywhere.ui.transfer.errorRes
import app.shareanywhere.ui.transfer.etaText
import app.shareanywhere.ui.transfer.percent

/** The joined receiver's transfer: RX-5b `rx-save`, RX-6 `rx-progress`, RX-7 `rx-done`. */
@Composable
fun ReceiveTransfer(
    rx: RxState,
    onChooseFolder: (Uri?) -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
    onDone: () -> Unit,
    onTurnKeepScreenOn: () -> Unit
) {
    val pill = rememberKeepAwake(needs = rx.phase.active())
    when (rx.phase) {
        RxPhase.Loading -> Column(Modifier.fillMaxSize().padding(SaTokens.Space.S4).testTag(ScreenIds.RX_SAVE)) {
            SkeletonList(3, stringResource(R.string.android_receiving))
        }
        RxPhase.Choose -> SaveLocation(rx, onChooseFolder)
        RxPhase.Completed, RxPhase.Partial, RxPhase.Failed, RxPhase.Cancelled -> Done(rx, onDone)
        else -> Progress(rx, pill, onTurnKeepScreenOn, onPause, onResume, onRetry, onCancel)
    }
}

@Composable
private fun SaveLocation(rx: RxState, onChooseFolder: (Uri?) -> Unit) {
    val p = LocalSaPalette.current
    val locale = LocalConfiguration.current.uiLocale()
    // Download/Share Anywhere by default (Android 10+); Choose folder picks another one.
    var picked by rememberSaveable { mutableStateOf(if (Folders.defaultAvailable) Folders.DEFAULT_DOWNLOADS else null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri !=
            null
        ) {
            picked = uri.toString()
        }
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SaTokens.Space.S4).testTag(ScreenIds.RX_SAVE),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Text(
            stringResource(R.string.product_rx_save_h),
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(top = SaTokens.Space.S3).semantics {
                heading()
            }
        )
        SecurityWords(rx.words, stringResource(R.string.android_xx_secw_r))
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(SaTokens.Radius.Lg))
                .background(MaterialTheme.colorScheme.surface)
                .clickable(role = Role.Button) { picker.launch(null) }
                .padding(SaTokens.Space.S4)
                .testTag("rx.choose-folder"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
        ) {
            Icon(
                painterResource(R.drawable.ic_folder_open),
                contentDescription = null,
                tint = p.sendInk,
                modifier = Modifier.size(SaTokens.Space.S8)
            )
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.product_rx_choose_folder), style = MaterialTheme.typography.titleSmall)
                Text(
                    when (val pk = picked) {
                        null -> stringResource(R.string.product_rx_folder_hint)
                        Folders.DEFAULT_DOWNLOADS -> Folders.DEFAULT_LABEL
                        else -> pk.toUri().lastPathSegment?.substringAfter(':').orEmpty()
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = p.fg2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Icon(painterResource(R.drawable.ic_chevron_right), contentDescription = null, tint = p.fg3)
        }
        InlineNotice(NoticeKind.Info, R.drawable.ic_info, stringResource(R.string.product_rx_save_note))
        SaCard {
            Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                rx.files.forEach { f ->
                    Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
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
            }
        }
        PrimaryButton(
            stringResource(R.string.android_startrx),
            {
                picked?.let { onChooseFolder(it.toUri()) }
            },
            Modifier.testTag("rx.start"),
            tone = Tone.Receive,
            enabled =
            picked != null
        )
    }
}

@Composable
private fun Progress(
    rx: RxState,
    pill: app.shareanywhere.ui.keepawake.PillState,
    onTurnKeepScreenOn: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onRetry: () -> Unit,
    onCancel: () -> Unit
) {
    val p = LocalSaPalette.current
    val locale = LocalConfiguration.current.uiLocale()
    var confirmCancel by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().testTag(ScreenIds.RX_PROGRESS)) {
        Box(Modifier.padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S1)) {
            Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
                KeepOpenBanner(pill, onTurnKeepScreenOn)
                Text(
                    stringResource(R.string.product_hint_android_screen_off),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.fg2,
                    modifier = Modifier.padding(horizontal = SaTokens.Space.S2)
                )
            }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(SaTokens.Space.S4),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.android_receiving),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f).semantics {
                        heading()
                    }
                )
                RouteChip(rx.route)
            }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                val frac = if (rx.total > 0) rx.verified.toFloat() / rx.total else 0f
                CircularProgressIndicator(
                    progress = { frac },
                    modifier = Modifier.size(SaTokens.Space.S16 * 2 + SaTokens.Space.S8 + SaTokens.Space.S2),
                    strokeWidth = SaTokens.Space.S3,
                    color = p.receive,
                    trackColor = p.track
                )
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        percent(rx.verified, rx.total),
                        style = MaterialTheme.typography.headlineMedium,
                        modifier = Modifier.testTag("rx.percent")
                    )
                    Text(
                        "${formatBytes(rx.verified, locale)} / ${formatBytes(rx.total, locale)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = p.fg2,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                StatusChip(rx.phase.chip())
                Text(
                    "  " +
                        (
                            if (rx.bytesPerSecond >
                                0
                            ) {
                                str(R.string.product_per_second, "size" to formatBytes(rx.bytesPerSecond.toLong(), locale)) + " · "
                            } else {
                                ""
                            }
                            ) +
                        etaText(rx.eta),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.fg2
                )
            }
            rx.target?.let { t ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                    Icon(
                        painterResource(R.drawable.ic_folder),
                        contentDescription = null,
                        tint = p.fg2,
                        modifier = Modifier.size(SaTokens.Space.S4)
                    )
                    Text(t.label, style = MaterialTheme.typography.bodySmall, color = p.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (rx.phase ==
                RxPhase.Reconnecting
            ) {
                InlineNotice(NoticeKind.Warning, R.drawable.ic_wifi_off, stringResource(R.string.product_rx_reconnecting))
            }
            if (rx.phase == RxPhase.Unreachable) {
                InlineNotice(NoticeKind.Error, R.drawable.ic_wifi_off, stringResource(R.string.product_tx_err_unreachable), action = {
                    SecondaryButton(stringResource(R.string.common_retry), onRetry, Modifier.testTag("rx.retry"))
                })
            }
            SecurityWords(rx.words, stringResource(R.string.android_xx_secw_r))
            SaCard {
                Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                    rx.files.forEach { f ->
                        Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
                            Row {
                                Text(
                                    f.name,
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                Text(
                                    percent(if (f.done) f.size else f.verified, f.size),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = p.fg2
                                )
                            }
                            ProgressLine(
                                if (f.size >
                                    0
                                ) {
                                    (if (f.done) 1f else f.verified.toFloat() / f.size)
                                } else {
                                    1f
                                },
                                f.name,
                                height = SaTokens.Space.S1,
                                tone = if (f.done) p.receive else p.send
                            )
                        }
                    }
                }
            }
        }
        Row(Modifier.padding(SaTokens.Space.S4), horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
            if (rx.phase == RxPhase.Paused) {
                PrimaryButton(
                    stringResource(R.string.android_resume),
                    onResume,
                    Modifier.weight(1f).testTag("rx.resume"),
                    tone = Tone.Receive,
                    icon = R.drawable.ic_play_arrow
                )
            } else if (rx.phase != RxPhase.Unreachable && rx.phase != RxPhase.Verifying) {
                SecondaryButton(
                    stringResource(R.string.android_pause),
                    onPause,
                    Modifier.weight(1f).testTag("rx.pause"),
                    icon = R.drawable.ic_pause
                )
            }
            SecondaryButton(stringResource(R.string.android_cancel), {
                confirmCancel = true
            }, Modifier.weight(1f).testTag("rx.cancel-transfer"))
        }
    }
    if (confirmCancel) {
        ConfirmDialog(
            title = stringResource(R.string.product_rx_cancel_h),
            body = stringResource(R.string.product_rx_cancel_p),
            confirm = stringResource(R.string.android_cancel),
            onConfirm = {
                confirmCancel = false
                onCancel()
            },
            onDismiss = { confirmCancel = false }
        )
    }
}

@Composable
private fun Done(rx: RxState, onDone: () -> Unit) {
    val p = LocalSaPalette.current
    val locale = LocalConfiguration.current.uiLocale()
    val context = LocalContext.current
    val done = rx.files.count { it.done }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SaTokens.Space.S4).testTag(ScreenIds.RX_DONE),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        val (icon, bg, fg) =
            when (rx.phase) {
                RxPhase.Completed -> Triple(R.drawable.ic_check, p.receiveSoft, p.receiveInk)
                RxPhase.Partial -> Triple(R.drawable.ic_incomplete_circle, p.warningSoft, p.warningInk)
                RxPhase.Failed -> Triple(R.drawable.ic_gpp_bad, p.dangerSoft, p.dangerInk)
                else -> Triple(R.drawable.ic_cancel, p.surface2, p.fg2)
            }
        Box(
            Modifier.padding(top = SaTokens.Space.S6).size(SaTokens.Space.S16 + SaTokens.Space.S4).clip(CircleShape).background(bg),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(icon),
                contentDescription = null,
                tint = fg,
                modifier = Modifier.size(SaTokens.Space.S8 + SaTokens.Space.S2)
            )
        }
        val title =
            when (rx.phase) {
                RxPhase.Completed -> stringResource(R.string.android_done_h)
                RxPhase.Partial -> str(R.string.product_rx_partial_h, "done" to done, "count" to rx.files.size)
                RxPhase.Failed -> stringResource(R.string.product_rx_failed_h)
                else -> stringResource(R.string.product_rx_cancelled_h)
            }
        Text(
            title,
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics {
                heading()
            }.testTag("rx.result")
        )
        if (rx.phase == RxPhase.Completed) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
                Icon(
                    painterResource(R.drawable.ic_verified_user),
                    contentDescription = null,
                    tint = p.receiveInk,
                    modifier = Modifier.size(SaTokens.Space.S4)
                )
                Text(
                    str(
                        R.string.product_rx_verified,
                        "count" to
                            if (rx.files.size ==
                                1
                            ) {
                                stringResource(R.string.product_files_count_one)
                            } else {
                                str(
                                    R.string.product_files_count,
                                    "n" to rx.files.size
                                )
                            },
                        "size" to formatBytes(rx.total, locale)
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.receiveInk
                )
            }
        }
        if (rx.phase ==
            RxPhase.Partial
        ) {
            Text(
                stringResource(R.string.product_rx_partial_p),
                style = MaterialTheme.typography.bodyMedium,
                color = p.fg2,
                textAlign = TextAlign.Center
            )
        }
        if (rx.phase ==
            RxPhase.Failed
        ) {
            Text(
                stringResource(errorRes(rx.error)),
                style = MaterialTheme.typography.bodyMedium,
                color = p.fg2,
                textAlign = TextAlign.Center
            )
        }
        rx.target?.let {
            if (done >
                0
            ) {
                Text(str(R.string.product_rx_saved_to, "folder" to it.label), style = MaterialTheme.typography.bodySmall, color = p.fg2)
            }
        }
        if (done > 0) {
            SaCard {
                rx.files.filter { it.done && it.documentUri != null }.forEach { f ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(
                            min = SaTokens.Space.S12 + SaTokens.Space.S2
                        ).padding(start = SaTokens.Space.S4, end = SaTokens.Space.S1),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_description),
                            contentDescription = null,
                            tint = p.fg2,
                            modifier = Modifier.size(SaTokens.Space.S6)
                        )
                        Text(
                            f.name,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).padding(horizontal = SaTokens.Space.S3)
                        )
                        IconButton(onClick = {
                            open(context, f.documentUri!!.toUri(), f.mime)
                        }, modifier = Modifier.size(SaTokens.Space.S12)) {
                            Icon(
                                painterResource(R.drawable.ic_folder_open),
                                contentDescription = str(
                                    R.string.product_rx_open_file_named,
                                    "name" to f.name
                                )
                            )
                        }
                        IconButton(onClick = {
                            share(context, f.documentUri!!.toUri(), f.mime)
                        }, modifier = Modifier.size(SaTokens.Space.S12)) {
                            Icon(
                                painterResource(R.drawable.ic_share),
                                contentDescription = str(
                                    R.string.product_rx_share_file_named,
                                    "name" to f.name
                                )
                            )
                        }
                    }
                }
            }
        }
        PrimaryButton(stringResource(R.string.android_yy_done), onDone, Modifier.testTag("rx.done"), tone = Tone.Receive)
    }
}

private fun open(context: android.content.Context, uri: Uri, mime: String) {
    try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(
                uri,
                mime.ifBlank {
                    "*/*"
                }
            ).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        )
    } catch (_: ActivityNotFoundException) {
        android.widget.Toast.makeText(context, context.getString(R.string.product_rx_no_app), android.widget.Toast.LENGTH_SHORT).show()
    }
}

private fun share(context: android.content.Context, uri: Uri, mime: String) {
    val send = Intent(Intent.ACTION_SEND).setType(
        mime.ifBlank {
            "*/*"
        }
    ).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, null))
}
