package app.shareanywhere.ui.history

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.ui.account.AccountViewModel
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.theme.SaTokens

class HistorySyncActions(
    val signIn: () -> Unit,
    val addDevice: () -> Unit,
    val setUpKeys: () -> Unit,
    val pair: () -> Unit,
    val phrase: () -> Unit
)

/**
 * HI-1 banner by account state (docs/UX_SCREEN_MAP.md §6 "As built"): guest "Sign in to sync your history"; not added →
 * Add this device; key states with their action; sync off → `common.local` with Turn on history sync; sync on → "Synced
 * {when}" with Sync now, "Syncing…", or an error with Retry; entries this device cannot read yet are counted.
 */
@Composable
fun HistorySyncBanner(actions: HistorySyncActions, viewModel: AccountViewModel = hiltViewModel()) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val m = Modifier.testTag("history.sync-banner")
    // A failed action from the banner (for example Turn on history sync while offline) says why.
    app.shareanywhere.ui.account.AccountError(error)

    @Composable
    fun info(title: String, label: String? = null, onClick: () -> Unit = {}, kind: NoticeKind = NoticeKind.Info) = InlineNotice(
        kind,
        if (kind == NoticeKind.Error) R.drawable.ic_error else R.drawable.ic_sync,
        title,
        m,
        action = label?.let { { TextButton(onClick = onClick, modifier = Modifier.testTag("history.sync-action")) { Text(it) } } }
    )
    when {
        !s.signedIn -> InlineNotice(
            NoticeKind.Info,
            R.drawable.ic_smartphone,
            stringResource(
                R.string.android_yy_local
            ),
            m,
            body = stringResource(R.string.product_history_signin),
            action = {
                TextButton(onClick = actions.signIn, modifier = Modifier.testTag("history.signin")) {
                    Text(stringResource(R.string.android_yy_signin))
                }
            }
        )
        s.meFailed -> info(stringResource(R.string.product_account_load_failed), stringResource(R.string.common_retry), {
            viewModel.retryMe()
        }, NoticeKind.Error)
        !s.added -> info(stringResource(R.string.product_add_device), stringResource(R.string.product_add_device_btn), actions.addDevice)
        s.keys == KeyStatus.Setup -> info(
            stringResource(R.string.product_history_keys_setup),
            stringResource(R.string.product_key_setup_cta),
            actions.setUpKeys
        )
        s.keys == KeyStatus.Pair -> info(
            stringResource(R.string.product_history_pair),
            stringResource(R.string.product_pair_h),
            actions.pair
        )
        s.keys == KeyStatus.Error -> info(stringResource(R.string.product_keys_error), stringResource(R.string.common_retry), {
            viewModel.retryKeys()
        }, NoticeKind.Error)
        s.keys == KeyStatus.Legacy -> info(stringResource(R.string.product_keys_legacy), kind = NoticeKind.Error)
        s.keys == KeyStatus.Rejected || s.keys == KeyStatus.Refused -> {
            val rejected = s.keys == KeyStatus.Rejected
            InlineNotice(
                NoticeKind.Error,
                R.drawable.ic_gpp_bad,
                stringResource(if (rejected) R.string.product_key_change_unverified else R.string.product_keys_refused),
                m,
                body = stringResource(if (rejected) R.string.product_key_change_unverified_p else R.string.product_keys_refused_p),
                action = {
                    Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                        TextButton(onClick = actions.pair) { Text(stringResource(R.string.product_pair_again)) }
                        TextButton(onClick = actions.phrase) { Text(stringResource(R.string.product_use_phrase)) }
                    }
                }
            )
        }
        s.keys != KeyStatus.Ready -> info(stringResource(R.string.product_keys_checking))
        !s.historySync -> InlineNotice(NoticeKind.Info, R.drawable.ic_smartphone, stringResource(R.string.android_yy_local), m, action = {
            TextButton(onClick = {
                viewModel.setHistorySync(true)
            }, modifier = Modifier.testTag("history.sync-on")) { Text(stringResource(R.string.product_turn_on_history_sync)) }
        })
        s.sync.running -> info(stringResource(R.string.product_history_syncing))
        s.sync.error ->
            info(
                stringResource(if (s.sync.offline) R.string.product_history_sync_offline else R.string.product_history_sync_failed),
                stringResource(R.string.common_retry),
                { viewModel.syncNow() },
                NoticeKind.Error
            )
        s.sync.unreadable > 0 -> info(
            str(R.string.product_history_unreadable, "n" to s.sync.unreadable),
            stringResource(R.string.product_pair_again),
            actions.pair,
            NoticeKind.Warning
        )
        s.sync.at != null -> info(
            str(
                R.string.product_history_synced_at,
                "when" to whenText(s.sync.at!!, System.currentTimeMillis())
            ),
            stringResource(R.string.product_history_sync_now),
            {
                viewModel.syncNow()
            }
        )
        else -> info(stringResource(R.string.product_history_synced_sub), stringResource(R.string.product_history_sync_now), {
            viewModel.syncNow()
        })
    }
}
