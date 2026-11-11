package app.shareanywhere.ui.history

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import app.shareanywhere.R
import app.shareanywhere.history.Direction
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryRoute
import app.shareanywhere.history.HistoryStatus
import app.shareanywhere.history.peerNames
import app.shareanywhere.history.transferred
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.StatusPill
import app.shareanywhere.ui.format.formatBytes
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.SaMonoCaption
import app.shareanywhere.ui.theme.SaTokens

/**
 * HI-2 History detail (design history drawer): direction and title, status, device, when, transferred bytes vs
 * size, route and duration when recorded, integrity, files, Delete from history. No "Send again": the app keeps
 * no access to the files after a transfer (DESIGN_DEVIATIONS G16).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryDetailSheet(entry: HistoryEntry, now: Long, onDelete: () -> Unit, onDismiss: () -> Unit) {
    val locale = LocalConfiguration.current.uiLocale()
    val look = statusLook(entry.status)
    val done = entry.transferred()
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag(ScreenIds.HISTORY_DETAIL)) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = SaTokens.Space.S6)
                .padding(bottom = SaTokens.Space.S6),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.android_xx_h_detail),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f).semantics { heading() }
                )
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.android_xx_close)) }
            }
            val dir = stringResource(if (entry.direction == Direction.SENT) R.string.android_yy_f_sent else R.string.android_yy_f_recv)
            Text("$dir · ${entryTitle(entry)}", style = MaterialTheme.typography.titleMedium)
            StatusPill(look.icon, stringResource(look.label), look.background, look.foreground)
            SaCard {
                Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                    Field(stringResource(R.string.android_xx_h_peer), entry.peerNames().joinToString(", ").ifEmpty { entry.peer })
                    Field(stringResource(R.string.android_xx_h_when), whenText(entry.createdAt, now))
                    Field(
                        stringResource(R.string.android_xx_h_size),
                        when {
                            done == null -> "—"
                            done < entry.totalBytes ->
                                str(
                                    R.string.product_history_partial_bytes,
                                    "done" to formatBytes(done, locale),
                                    "total" to formatBytes(entry.totalBytes, locale)
                                )
                            else -> formatBytes(done, locale)
                        },
                        mono = true
                    )
                    if (done == null || done < entry.totalBytes) {
                        Field(stringResource(R.string.product_history_original_size), formatBytes(entry.totalBytes, locale), mono = true)
                    }
                    entry.route?.let { route ->
                        val label =
                            when (route) {
                                HistoryRoute.DIRECT -> R.string.handoff_p2p
                                HistoryRoute.RELAY -> R.string.handoff_relay
                                HistoryRoute.MIXED -> R.string.product_history_route_mixed
                            }
                        Field(stringResource(R.string.product_history_route), stringResource(label))
                    }
                    entry.startedAt?.let { start ->
                        val seconds = ((entry.createdAt - start) / 1000).coerceAtLeast(0)
                        Field(stringResource(R.string.product_history_duration), duration(seconds))
                    }
                    Field(
                        stringResource(R.string.android_xx_h_int),
                        stringResource(
                            if (entry.status ==
                                HistoryStatus.COMPLETED
                            ) {
                                R.string.android_xx_h_ok
                            } else {
                                R.string.android_xx_h_bad
                            }
                        )
                    )
                    entry.origin?.let { Field(stringResource(R.string.product_history_origin), it) }
                }
            }
            val files = entry.files.orEmpty()
            if (files.isNotEmpty()) {
                SaCard {
                    Column(Modifier.padding(SaTokens.Space.S4), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                        for (f in files) {
                            Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
                                Text(f.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                                Text(formatBytes(f.size, locale), style = SaMonoCaption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            OutlinedButton(
                onClick = onDelete,
                modifier = Modifier.fillMaxWidth().heightIn(min = SaTokens.TouchTarget).testTag("history.delete")
            ) {
                Text(stringResource(R.string.android_xx_h_del), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun Field(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S4)) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(0.4f)
        )
        Text(value, style = if (mono) SaMonoCaption else MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(0.6f))
    }
}

@Composable
private fun duration(seconds: Long): String = when {
    seconds >= 3600 -> str(R.string.product_eta_hm, "h" to seconds / 3600, "m" to (seconds % 3600) / 60)
    seconds >= 60 -> str(R.string.product_eta_ms, "m" to seconds / 60, "s" to seconds % 60)
    else -> str(R.string.product_eta_s, "s" to seconds)
}
