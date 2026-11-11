package app.shareanywhere.ui.history

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import app.shareanywhere.R
import app.shareanywhere.history.Direction
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryStatus
import app.shareanywhere.history.peerNames
import app.shareanywhere.history.transferred
import app.shareanywhere.ui.format.WhenLabel
import app.shareanywhere.ui.format.formatBytes
import app.shareanywhere.ui.format.whenLabel
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.strP
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

/** Status label, icon and colours (design `chip`: icon plus label, never colour alone). */
data class StatusLook(@StringRes val label: Int, val icon: Int, val background: Color, val foreground: Color)

@Composable
@ReadOnlyComposable
fun statusLook(status: HistoryStatus): StatusLook {
    val p = LocalSaPalette.current
    return when (status) {
        HistoryStatus.COMPLETED -> StatusLook(R.string.android_lbl_completed, R.drawable.ic_check_circle, p.receiveSoft, p.receiveInk)
        HistoryStatus.PARTIAL -> StatusLook(R.string.android_lbl_partial, R.drawable.ic_incomplete_circle, p.warningSoft, p.warningInk)
        HistoryStatus.FAILED -> StatusLook(R.string.android_lbl_failed, R.drawable.ic_error, p.dangerSoft, p.dangerInk)
        HistoryStatus.CANCELLED -> StatusLook(R.string.android_lbl_cancelled, R.drawable.ic_cancel, p.surface2, p.fg2)
    }
}

/** "Today 14:05", "Yesterday, 09:12" (design patterns) or a localized date and time. */
@Composable
@ReadOnlyComposable
fun whenText(epochMs: Long, now: Long): String = when (val w = whenLabel(epochMs, now, LocalConfiguration.current.uiLocale())) {
    is WhenLabel.Today -> strP(R.string.android_patterns_today_x, w.time)
    is WhenLabel.Yesterday -> strP(R.string.android_patterns_yesterday_x, w.time)
    is WhenLabel.OnDate -> "${w.date} · ${w.time}"
}

/** The row title: the entry title, or "name + n files" when per-file names are known. */
@Composable
@ReadOnlyComposable
fun entryTitle(e: HistoryEntry): String {
    val files = e.files.orEmpty()
    return when {
        files.size == 2 -> str(R.string.product_history_title_more_one, "name" to files[0].name)
        files.size > 2 -> str(R.string.product_history_title_more, "name" to files[0].name, "n" to files.size - 1)
        else -> e.title
    }
}

/** Size column: total, or "done of total" for a partial transfer. */
@Composable
@ReadOnlyComposable
fun entrySize(e: HistoryEntry): String {
    val locale = LocalConfiguration.current.uiLocale()
    val done = e.transferred()
    return if (done != null && done < e.totalBytes && e.status != HistoryStatus.COMPLETED) {
        str(R.string.product_history_partial_bytes, "done" to formatBytes(done, locale), "total" to formatBytes(e.totalBytes, locale))
    } else {
        formatBytes(e.totalBytes, locale)
    }
}

/** One history row (design `histList` item): direction tile, title, peer and time, size, status. */
@Composable
fun HistoryRow(entry: HistoryEntry, now: Long, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val p = LocalSaPalette.current
    val sent = entry.direction == Direction.SENT
    val look = statusLook(entry.status)
    val title = entryTitle(entry)
    val peer = entry.peerNames().joinToString(", ").ifEmpty { entry.peer }
    val whenStr = whenText(entry.createdAt, now)
    val size = entrySize(entry)
    val status = stringResource(look.label)
    val direction = stringResource(if (sent) R.string.android_yy_f_sent else R.string.android_yy_f_recv)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = SaTokens.TouchTarget + SaTokens.Space.S2)
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics(mergeDescendants = true) { contentDescription = "$direction · $title · $peer · $whenStr · $size · $status" }
            .testTag("history.row.${entry.id}")
            .padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Box(
            Modifier
                .size(SaTokens.Control.Sm + SaTokens.Space.S1)
                .clip(RoundedCornerShape(SaTokens.Radius.Md))
                .background(if (sent) p.sendSoft else p.receiveSoft),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(if (sent) R.drawable.ic_north_east else R.drawable.ic_south_west),
                contentDescription = null,
                tint = if (sent) p.sendInk else p.receiveInk
            )
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "$peer · $whenStr",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Text(size, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(painterResource(look.icon), contentDescription = null, tint = look.foreground)
    }
}
