package app.shareanywhere.ui.send

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.data.api.OpenSession
import app.shareanywhere.sharing.PickedFile
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.FlowTopBar
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.components.SwitchRow
import app.shareanywhere.ui.format.formatBytes
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens
import app.shareanywhere.ui.transfer.CloudConsentDialog
import app.shareanywhere.ui.transfer.CloudSendOption
import java.text.DateFormat
import java.util.Date

/**
 * TR-2/TR-3 design screen `send`: Choose files (SAF multi-select), the picked list with remove and Add more, the
 * session total, Require approval (default off, deviation I14) and Create share session. Hitting the open-session
 * cap lists the device's open sessions with Open and Close.
 */
@Composable
fun SendScreen(
    onBack: () -> Unit,
    onCreated: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    viewModel: SendViewModel = hiltViewModel()
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val locale = LocalConfiguration.current.uiLocale()
    val p = LocalSaPalette.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { viewModel.add(it) }
    val openPicker = { picker.launch(arrayOf("*/*")) }
    var confirmClose by remember { mutableStateOf<OpenSession?>(null) }
    LaunchedEffect(viewModel) { viewModel.created.collect(onCreated) }
    if (ui.consenting) CloudConsentDialog(ui.estimate, ui.cloudBusy, viewModel::approveCloud, viewModel::dismissCloud)

    Column(Modifier.fillMaxSize().testTag(ScreenIds.SEND)) {
        FlowTopBar(stringResource(R.string.android_choose), R.drawable.ic_arrow_back, stringResource(R.string.product_back), onBack)
        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
        ) {
            if (ui.files.isEmpty()) {
                item {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(SaTokens.Radius.Xl))
                            .border(SaTokens.Border.Thin, p.fg3, RoundedCornerShape(SaTokens.Radius.Xl))
                            .padding(SaTokens.Space.S6)
                            .testTag("send.empty"),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_upload_file),
                            contentDescription = null,
                            tint = p.sendInk,
                            modifier = Modifier.size(SaTokens.Space.S12)
                        )
                        Text(stringResource(R.string.product_send_empty_h), style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(R.string.product_send_empty_p),
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.fg2,
                            textAlign = TextAlign.Center
                        )
                        PrimaryButton(stringResource(R.string.android_choose), openPicker, Modifier.testTag("send.choose"))
                    }
                }
            } else {
                item {
                    Row(Modifier.fillMaxWidth().padding(horizontal = SaTokens.Space.S1), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            if (ui.files.size ==
                                1
                            ) {
                                stringResource(R.string.product_files_count_one)
                            } else {
                                str(
                                    R.string.product_files_count,
                                    "n" to ui.files.size
                                )
                            },
                            style = MaterialTheme.typography.titleSmall
                        )
                        Text(
                            stringResource(R.string.android_total) + " " + formatBytes(ui.total, locale),
                            style = MaterialTheme.typography.bodySmall,
                            color = p.fg2,
                            modifier = Modifier.testTag("send.total")
                        )
                    }
                }
                item {
                    SaCard {
                        ui.files.forEachIndexed { i, f ->
                            FileRow(f, locale, onRemove = { viewModel.remove(f) })
                            if (i < ui.files.lastIndex) app.shareanywhere.ui.components.RowDivider()
                        }
                    }
                }
                item {
                    SecondaryButton(
                        stringResource(R.string.product_add_more),
                        openPicker,
                        Modifier.fillMaxWidth(),
                        icon = R.drawable.ic_add
                    )
                }
                item {
                    SaCard {
                        SwitchRow(
                            label = stringResource(R.string.android_reqappr),
                            checked = ui.requireApproval,
                            onCheckedChange = viewModel::setRequireApproval,
                            description = stringResource(if (ui.requireApproval) R.string.product_appr_on else R.string.product_appr_off),
                            modifier = Modifier.testTag("send.approval")
                        )
                    }
                }
                item {
                    val cloudError = ui.cloudError?.let { str(it.id, *it.args.toList().toTypedArray()) }
                    CloudSendOption(ui.cloudSettings, ui.cloud, viewModel::toggleCloud, cloudError)
                }
            }
            if (ui.overLimit) {
                item {
                    InlineNotice(
                        NoticeKind.Error,
                        R.drawable.ic_error,
                        str(R.string.product_over_limit, "amount" to formatBytes((ui.total - SESSION_LIMIT_BYTES).coerceAtLeast(0), locale))
                    )
                }
            }
            if (ui.unreadable.isNotEmpty()) {
                item {
                    InlineNotice(
                        NoticeKind.Warning,
                        R.drawable.ic_error,
                        str(R.string.product_file_unreadable, "name" to ui.unreadable.joinToString(", ")),
                        onDismiss = viewModel::dismissUnreadable
                    )
                }
            }
            ui.error?.let { e ->
                item {
                    Box(Modifier.semantics { liveRegion = LiveRegionMode.Assertive }) {
                        InlineNotice(
                            NoticeKind.Error,
                            R.drawable.ic_error,
                            str(e.id, *e.args.toList().toTypedArray()),
                            Modifier.testTag("send.error")
                        )
                    }
                }
            }
            if (ui.open != OpenSessions.Hidden) {
                item {
                    OpenSessionsPanel(ui, locale, onOpen = onOpenSession, onClose = { confirmClose = it }, onRetry = viewModel::loadOpen)
                }
            }
        }
        if (ui.files.isNotEmpty()) {
            PrimaryButton(
                stringResource(R.string.android_create),
                viewModel::create,
                Modifier.padding(SaTokens.Space.S4).testTag("send.create"),
                enabled = !ui.overLimit,
                busy = ui.creating
            )
        }
    }
    confirmClose?.let { s ->
        ConfirmDialog(
            title = stringResource(R.string.product_close_h),
            body = stringResource(R.string.product_close_p),
            confirm = stringResource(R.string.android_close),
            onConfirm = {
                confirmClose = null
                viewModel.closeOpen(s.id)
            },
            onDismiss = { confirmClose = null }
        )
    }
}

@Composable
private fun FileRow(f: PickedFile, locale: java.util.Locale, onRemove: () -> Unit) {
    val p = LocalSaPalette.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = SaTokens.Space.S16).padding(start = SaTokens.Space.S3, end = SaTokens.Space.S1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Box(
            Modifier.size(SaTokens.Space.S8 + SaTokens.Space.S2).clip(RoundedCornerShape(SaTokens.Radius.Md)).background(p.surface2),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(R.drawable.ic_description),
                contentDescription = null,
                tint = p.fg2,
                modifier = Modifier.size(SaTokens.Space.S6)
            )
        }
        Column(Modifier.weight(1f)) {
            Text(f.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(formatBytes(f.size, locale), style = MaterialTheme.typography.bodySmall, color = p.fg2)
        }
        IconButton(onClick = onRemove, modifier = Modifier.size(SaTokens.Space.S12)) {
            Icon(
                painterResource(R.drawable.ic_close),
                contentDescription = str(R.string.product_remove_file, "name" to f.name),
                tint = p.fg2
            )
        }
    }
}

@Composable
private fun OpenSessionsPanel(
    ui: SendUi,
    locale: java.util.Locale,
    onOpen: (String) -> Unit,
    onClose: (OpenSession) -> Unit,
    onRetry: () -> Unit
) {
    val p = LocalSaPalette.current
    SaCard(Modifier.testTag("send.open-sessions")) {
        Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Text(stringResource(R.string.product_open_sessions_h), style = MaterialTheme.typography.titleMedium)
            when (val o = ui.open) {
                OpenSessions.Hidden -> Unit
                OpenSessions.Loading -> Text(stringResource(R.string.product_open_sessions_loading), color = p.fg2)
                OpenSessions.Failed ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.product_open_sessions_error), color = p.dangerInk, modifier = Modifier.weight(1f))
                        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
                    }
                is OpenSessions.Ready -> {
                    Text(
                        str(R.string.product_open_sessions_p, "max" to o.list.maxOpen),
                        style = MaterialTheme.typography.bodySmall,
                        color = p.fg2
                    )
                    if (o.list.sessions.isEmpty()) Text(stringResource(R.string.product_open_sessions_empty), color = p.fg2)
                    o.list.sessions.forEach { s -> OpenSessionRow(s, o.list.maxOpen, locale, ui.closingId == s.id, onOpen, onClose) }
                }
            }
        }
    }
}

@Composable
private fun OpenSessionRow(
    s: OpenSession,
    max: Int,
    locale: java.util.Locale,
    closing: Boolean,
    onOpen: (String) -> Unit,
    onClose: (OpenSession) -> Unit
) {
    val p = LocalSaPalette.current
    val title =
        when (val more = s.fileCount - 1) {
            0 -> s.firstFileName
            1 -> str(R.string.product_history_title_more_one, "name" to s.firstFileName)
            else -> str(R.string.product_history_title_more, "name" to s.firstFileName, "n" to more)
        }
    val time = { iso: String ->
        runCatching {
            DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(Date(java.time.Instant.parse(iso).toEpochMilli()))
        }.getOrDefault("")
    }
    val window =
        when (s.joinWindow.state) {
            "OPEN" -> str(R.string.product_open_session_window_open, "time" to time(s.joinWindow.endsAt))
            "ENDED_FULL" -> stringResource(R.string.product_open_session_window_full)
            "ENDED_BY_SENDER" -> stringResource(R.string.product_not_accepting_s)
            else -> stringResource(R.string.product_open_session_window_expired)
        }
    Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
        Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            str(
                R.string.product_open_session_meta,
                "time" to time(s.createdAt),
                "joined" to s.capacity.joined,
                "max" to s.capacity.max,
                "window" to window
            ),
            style = MaterialTheme.typography.bodySmall,
            color = p.fg2
        )
        Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
            SecondaryButton(stringResource(R.string.android_yy_open), { onOpen(s.id) })
            SecondaryButton(stringResource(R.string.android_close), { onClose(s) }, enabled = !closing)
        }
    }
}
