package app.shareanywhere.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.ui.components.EmptyState
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.Logo
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SkeletonList
import app.shareanywhere.ui.history.HistoryLoad
import app.shareanywhere.ui.history.HistoryRow
import app.shareanywhere.ui.identity.IdentityNotice
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.SaTokens

/** How many recent entries Transfer home shows before "See all". */
private const val RECENT = 3

/**
 * TR-1 Transfer home. Send and Receive arrive with their flows in milestone 6.2 (`sharing` flag); until then
 * the screen shows the identity state (ON-2) and recent transfers from local History, so nothing on it is a
 * dead button (CLAUDE.md §3, §8b).
 */
@Composable
fun HomeScreen(onOpenHistory: (entryId: String?) -> Unit, viewModel: HomeViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag(ScreenIds.HOME),
        contentPadding = PaddingValues(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S2),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S4)
    ) {
        item {
            Row(
                Modifier.fillMaxWidth().heightIn(min = SaTokens.Space.S12 + SaTokens.Space.S2),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Logo(size = SaTokens.Space.S6 + SaTokens.Space.S1, lockup = true)
            }
        }
        item {
            IdentityNotice(ui.identity, onRetry = viewModel::retryIdentity, onDismissReplaced = viewModel::dismissReplaced)
        }
        when (val h = ui.history) {
            HistoryLoad.Loading -> item { SkeletonList(3, stringResource(R.string.android_recent)) }
            HistoryLoad.Failed ->
                item {
                    InlineNotice(NoticeKind.Error, R.drawable.ic_error, stringResource(R.string.product_history_load_failed))
                }
            is HistoryLoad.Loaded ->
                if (h.entries.isEmpty()) {
                    item {
                        EmptyState(
                            R.drawable.ic_inbox,
                            stringResource(R.string.android_yy_empty_h),
                            stringResource(R.string.android_yy_empty_p),
                            Modifier.testTag("home.empty")
                        )
                    }
                } else {
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                stringResource(R.string.android_recent),
                                style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.weight(1f).semantics { heading() }
                            )
                            TextButton(onClick = { onOpenHistory(null) }, modifier = Modifier.testTag("home.see_all")) {
                                Text(stringResource(R.string.product_see_all))
                            }
                        }
                    }
                    item {
                        SaCard {
                            h.entries.take(RECENT).forEachIndexed { i, e ->
                                if (i > 0) RowDivider()
                                HistoryRow(e, ui.now, onOpen = { onOpenHistory(e.id) })
                            }
                        }
                    }
                }
        }
    }
}
