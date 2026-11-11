package app.shareanywhere.ui.identity

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import app.shareanywhere.R
import app.shareanywhere.identity.IdentityState
import app.shareanywhere.identity.IdentityStatus
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.format.formatCountdown
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.theme.SaTokens
import kotlinx.coroutines.delay

/**
 * ON-2: the identity bootstrap state inline on Transfer home and Devices. Nothing blocks navigation; local
 * features keep working while it shows (PRD §5.1).
 */
@Composable
fun IdentityNotice(state: IdentityState, onRetry: () -> Unit, onDismissReplaced: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        if (state.replaced) {
            InlineNotice(
                kind = NoticeKind.Info,
                icon = R.drawable.ic_info,
                title = stringResource(R.string.product_reset_done),
                body = stringResource(R.string.product_identity_replaced),
                onDismiss = onDismissReplaced,
                modifier = Modifier.testTag("identity.replaced")
            )
        }
        val retry: @Composable () -> Unit = {
            OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.android_yy_retry)) }
        }
        when (state.status) {
            IdentityStatus.Ready -> Unit
            IdentityStatus.Loading, IdentityStatus.SolvingChallenge ->
                InlineNotice(
                    kind = NoticeKind.Info,
                    icon = R.drawable.ic_smartphone,
                    title = stringResource(R.string.product_identity_loading),
                    modifier = Modifier.testTag("identity.loading")
                )
            IdentityStatus.Offline ->
                InlineNotice(
                    kind = NoticeKind.Warning,
                    icon = R.drawable.ic_wifi_off,
                    title = stringResource(R.string.android_yy_off_h),
                    body = stringResource(R.string.product_identity_offline),
                    action = retry,
                    modifier = Modifier.testTag("identity.offline")
                )
            IdentityStatus.RateLimited -> {
                var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
                LaunchedEffect(state.retryAt) {
                    while (true) {
                        now = System.currentTimeMillis()
                        delay(1_000)
                    }
                }
                val left = formatCountdown(((state.retryAt ?: now) - now + 999) / 1000)
                InlineNotice(
                    kind = NoticeKind.Warning,
                    icon = R.drawable.ic_error,
                    title = stringResource(R.string.product_identity_failed),
                    body = str(R.string.product_rate_limited, "time" to left),
                    action = { OutlinedButton(onClick = {}, enabled = false) { Text(str(R.string.product_retry_in, "time" to left)) } },
                    modifier = Modifier.testTag("identity.rate_limited")
                )
            }
            IdentityStatus.Failed ->
                InlineNotice(
                    kind = NoticeKind.Error,
                    icon = R.drawable.ic_error,
                    title = stringResource(R.string.product_identity_failed),
                    body = stringResource(R.string.product_error_generic),
                    action = retry,
                    modifier = Modifier.testTag("identity.failed")
                )
        }
    }
}
