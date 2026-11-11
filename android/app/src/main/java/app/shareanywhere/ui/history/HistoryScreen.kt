package app.shareanywhere.ui.history

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.history.HistoryChip
import app.shareanywhere.history.HistoryFilter
import app.shareanywhere.history.HistoryRange
import app.shareanywhere.history.HistoryStatus
import app.shareanywhere.ui.components.ConfirmDialog
import app.shareanywhere.ui.components.EmptyState
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.ScreenHeader
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.nav.LocalSnackbar
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.SaTokens

/** HI-1 History list with search and filters; HI-2 opens as a sheet (design `history` drawer). */
@Composable
fun HistoryScreen(sync: HistorySyncActions? = null, viewModel: HistoryViewModel = hiltViewModel()) {
    val syncOn =
        if (sync != null) {
            val accountVm: app.shareanywhere.ui.account.AccountViewModel = hiltViewModel()
            accountVm.state.collectAsStateWithLifecycle().value.let { it.added && it.historySync }
        } else {
            false
        }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val event by viewModel.events.collectAsStateWithLifecycle()
    var confirmClear by rememberSaveable { mutableStateOf(false) }
    val snackbar = LocalSnackbar.current

    val messages =
        mapOf(
            HistoryEvent.Removed to stringResource(R.string.phrases_removed_from_history),
            HistoryEvent.RemoveFailed to stringResource(R.string.product_history_delete_failed),
            HistoryEvent.Cleared to stringResource(R.string.android_yy_n_cleared),
            HistoryEvent.ClearFailed to stringResource(R.string.product_clear_failed)
        )
    LaunchedEffect(event) {
        event?.let {
            snackbar.showSnackbar(messages.getValue(it))
            viewModel.eventShown()
        }
    }

    val entries = (ui.load as? HistoryLoad.Loaded)?.entries.orEmpty()
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag(ScreenIds.HISTORY),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        item {
            ScreenHeader(stringResource(R.string.android_hist)) {
                if (entries.isNotEmpty()) {
                    TextButton(onClick = { confirmClear = true }, modifier = Modifier.testTag("history.clear")) {
                        Text(stringResource(R.string.android_yy_cb_clear))
                    }
                }
            }
        }
        item {
            OutlinedTextField(
                value = ui.filter.query,
                onValueChange = { viewModel.setFilter(ui.filter.copy(query = it)) },
                modifier = Modifier.fillMaxWidth().testTag("history.search"),
                singleLine = true,
                label = { Text(stringResource(R.string.android_yy_h_search)) },
                leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null) }
            )
        }
        item { Filters(ui.filter, ui.peers, viewModel::setFilter) }
        item {
            if (sync != null) {
                HistorySyncBanner(sync)
            } else {
                InlineNotice(
                    kind = NoticeKind.Info,
                    icon = R.drawable.ic_smartphone,
                    title = stringResource(R.string.android_yy_local)
                )
            }
        }
        when (val load = ui.load) {
            HistoryLoad.Loading -> item { SkeletonList(4, stringResource(R.string.android_hist)) }
            HistoryLoad.Failed ->
                item {
                    InlineNotice(
                        kind = NoticeKind.Error,
                        icon = R.drawable.ic_error,
                        title = stringResource(R.string.product_history_load_failed),
                        modifier = Modifier.testTag("history.error")
                    )
                }
            is HistoryLoad.Loaded ->
                when {
                    load.entries.isEmpty() ->
                        item {
                            EmptyState(
                                R.drawable.ic_inbox,
                                stringResource(R.string.android_yy_empty_h),
                                stringResource(R.string.android_yy_empty_p),
                                Modifier.testTag("history.empty")
                            )
                        }
                    ui.visible.isEmpty() ->
                        item {
                            EmptyState(
                                R.drawable.ic_inbox,
                                stringResource(R.string.android_yy_h_empty_h),
                                stringResource(R.string.android_yy_h_empty_p),
                                Modifier.testTag("history.nomatch")
                            )
                        }
                    else ->
                        item {
                            SaCard {
                                ui.visible.forEachIndexed { i, e ->
                                    if (i > 0) RowDivider()
                                    HistoryRow(e, ui.now, onOpen = { viewModel.open(e.id) })
                                }
                            }
                        }
                }
        }
    }

    ui.selected?.let { entry ->
        HistoryDetailSheet(
            entry = entry,
            now = ui.now,
            onDelete = { viewModel.remove(entry.id) },
            onDismiss = { viewModel.open(null) }
        )
    }
    if (confirmClear) {
        ConfirmDialog(
            title = stringResource(R.string.android_yy_hc_h),
            body =
            stringResource(R.string.android_yy_hc_p) +
                if (syncOn) "\n\n" + stringResource(R.string.product_history_clear_synced) else "",
            confirm = stringResource(R.string.android_yy_cb_clear),
            onConfirm = {
                confirmClear = false
                viewModel.clear()
            },
            onDismiss = { confirmClear = false }
        )
    }
}

@Composable
private fun Filters(filter: HistoryFilter, peers: List<String>, onChange: (HistoryFilter) -> Unit) {
    val chips =
        listOf(
            HistoryChip.ALL to R.string.android_yy_f_all,
            HistoryChip.SENT to R.string.android_yy_f_sent,
            HistoryChip.RECEIVED to R.string.android_yy_f_recv,
            HistoryChip.FAILED to R.string.android_yy_f_failed
        )
    Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
            for ((chip, label) in chips) {
                FilterChip(
                    selected = filter.chip == chip,
                    onClick = { onChange(filter.copy(chip = chip)) },
                    label = { Text(stringResource(label)) },
                    modifier = Modifier.testTag("history.chip.${chip.name.lowercase()}")
                )
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
            val statuses =
                listOf(
                    null to R.string.product_history_any_status,
                    HistoryStatus.COMPLETED to R.string.android_lbl_completed,
                    HistoryStatus.PARTIAL to R.string.android_lbl_partial,
                    HistoryStatus.FAILED to R.string.android_lbl_failed,
                    HistoryStatus.CANCELLED to R.string.android_lbl_cancelled
                )
            MenuChip(
                description = stringResource(R.string.product_filter_status),
                current = stringResource(statuses.first { it.first == filter.status }.second),
                active = filter.status != null,
                options = statuses.map { (v, l) -> stringResource(l) to { onChange(filter.copy(status = v)) } },
                tag = "history.filter.status"
            )
            val ranges =
                listOf(
                    HistoryRange.ALL to R.string.android_yy_f_all,
                    HistoryRange.DAYS_30 to R.string.product_history_range_30d,
                    HistoryRange.DAYS_7 to R.string.product_history_range_7d,
                    HistoryRange.TODAY to R.string.product_history_range_today
                )
            MenuChip(
                description = stringResource(R.string.product_filter_date),
                current = stringResource(ranges.first { it.first == filter.range }.second),
                active = filter.range != HistoryRange.ALL,
                options = ranges.map { (v, l) -> stringResource(l) to { onChange(filter.copy(range = v)) } },
                tag = "history.filter.date"
            )
            if (peers.isNotEmpty()) {
                val all = stringResource(R.string.product_history_all_devices)
                MenuChip(
                    description = stringResource(R.string.product_filter_device),
                    current = filter.peer ?: all,
                    active = filter.peer != null,
                    options =
                    listOf(all to { onChange(filter.copy(peer = null)) }) + peers.map { p -> p to { onChange(filter.copy(peer = p)) } },
                    tag = "history.filter.device"
                )
            }
        }
    }
}

/** A filter chip that opens a menu of choices; TalkBack reads "Filter by …, current value". */
@Composable
private fun MenuChip(description: String, current: String, active: Boolean, options: List<Pair<String, () -> Unit>>, tag: String) {
    var open by remember { mutableStateOf(false) }
    Box {
        FilterChip(
            selected = active,
            onClick = { open = true },
            label = { Text(current) },
            trailingIcon = { Icon(painterResource(R.drawable.ic_filter_list), contentDescription = null) },
            modifier = Modifier.testTag(tag).semantics { contentDescription = "$description, $current" }
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((label, pick) in options) {
                DropdownMenuItem(
                    text = { Text(label, style = MaterialTheme.typography.bodyLarge) },
                    onClick = {
                        open = false
                        pick()
                    },
                    modifier = Modifier.padding(horizontal = SaTokens.Space.S1)
                )
            }
        }
    }
}
