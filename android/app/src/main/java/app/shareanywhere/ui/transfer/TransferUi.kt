package app.shareanywhere.ui.transfer

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import app.shareanywhere.R
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.transfer.runtime.TxStatus
import app.shareanywhere.ui.components.StatusPill
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaPalette
import app.shareanywhere.ui.theme.SaTokens

/** "42 %" of verified bytes. */
fun percent(done: Long, total: Long): String = "${if (total > 0) (done * 100 / total) else 100} %"

/** Status chip state shared by the sender's receivers and the receiver's own transfer (design CHIP). */
enum class Chip(@StringRes val label: Int, val icon: Int) {
    Waiting(R.string.product_st_waiting, R.drawable.ic_hourglass_top),
    Offline(R.string.product_st_offline, R.drawable.ic_wifi_off),
    Connecting(R.string.android_lbl_connecting, R.drawable.ic_hourglass_top),
    Transferring(R.string.android_lbl_transferring, R.drawable.ic_north_east),
    Receiving(R.string.android_lbl_receiving, R.drawable.ic_south_west),
    Paused(R.string.android_lbl_paused, R.drawable.ic_pause),
    Reconnecting(R.string.android_lbl_reconnecting, R.drawable.ic_refresh),
    Verifying(R.string.android_lbl_verifying, R.drawable.ic_verified_user),
    Completed(R.string.android_lbl_completed, R.drawable.ic_check_circle),
    Partial(R.string.android_lbl_partial, R.drawable.ic_incomplete_circle),
    Failed(R.string.android_lbl_failed, R.drawable.ic_error),
    Cancelled(R.string.android_lbl_cancelled, R.drawable.ic_cancel),
    Removed(R.string.android_lbl_removed, R.drawable.ic_person_remove),
    Blocked(R.string.phrases_blocked, R.drawable.ic_block)
}

fun TxStatus.chip(): Chip = when (this) {
    TxStatus.Waiting -> Chip.Waiting
    TxStatus.Offline -> Chip.Offline
    TxStatus.Connecting -> Chip.Connecting
    TxStatus.Transferring -> Chip.Transferring
    TxStatus.Paused -> Chip.Paused
    TxStatus.Reconnecting -> Chip.Reconnecting
    TxStatus.Verifying -> Chip.Verifying
    TxStatus.Completed -> Chip.Completed
    TxStatus.Failed -> Chip.Failed
    TxStatus.Cancelled -> Chip.Cancelled
    TxStatus.Removed -> Chip.Removed
    TxStatus.Blocked -> Chip.Blocked
}

fun RxPhase.chip(): Chip = when (this) {
    RxPhase.Loading, RxPhase.Choose -> Chip.Waiting
    RxPhase.Connecting -> Chip.Connecting
    RxPhase.Transferring -> Chip.Receiving
    RxPhase.Paused -> Chip.Paused
    RxPhase.Reconnecting -> Chip.Reconnecting
    RxPhase.Verifying -> Chip.Verifying
    RxPhase.Completed -> Chip.Completed
    RxPhase.Partial -> Chip.Partial
    RxPhase.Failed -> Chip.Failed
    RxPhase.Cancelled -> Chip.Cancelled
    RxPhase.Unreachable -> Chip.Offline
}

private fun Chip.colors(p: SaPalette): Pair<Color, Color> = when (this) {
    Chip.Transferring, Chip.Receiving, Chip.Verifying -> p.sendSoft to p.sendInk
    Chip.Completed -> p.receiveSoft to p.receiveInk
    Chip.Offline, Chip.Reconnecting, Chip.Partial -> p.warningSoft to p.warningInk
    Chip.Failed -> p.dangerSoft to p.dangerInk
    else -> p.surface2 to p.fg2
}

@Composable
fun StatusChip(chip: Chip, modifier: Modifier = Modifier) {
    val (bg, fg) = chip.colors(LocalSaPalette.current)
    StatusPill(chip.icon, stringResource(chip.label), bg, fg, modifier)
}

/** Route chip (design ROUTE): Direct P2P or Relay; the test tag carries the detailed route kind (route-relay-udp, …). */
@Composable
fun RouteChip(route: String?, modifier: Modifier = Modifier, kind: app.shareanywhere.transfer.engine.RouteKind? = null) {
    if (route == null) return
    val p = LocalSaPalette.current
    val relay = route == "relay"
    StatusPill(
        if (relay) R.drawable.ic_cell_tower else R.drawable.ic_bolt,
        stringResource(if (relay) R.string.product_route_relay else R.string.product_route_direct),
        if (relay) p.sendSoft else p.receiveSoft,
        if (relay) p.sendInk else p.receiveInk,
        modifier.testTag("route-${kind?.wire ?: route}")
    )
}

/** Linear progress with a range for TalkBack; [tone] follows the status (design bars). */
@Composable
fun ProgressLine(value: Float, label: String, modifier: Modifier = Modifier, height: Dp = SaTokens.Space.S2, tone: Color? = null) {
    val p = LocalSaPalette.current
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .clip(CircleShape)
            .background(p.track)
            .semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo(value.coerceIn(0f, 1f), 0f..1f)
            }
    ) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(value.coerceIn(0f, 1f)).clip(CircleShape).background(tone ?: p.send))
    }
}

/** "3 min 20 s left" or "Estimating time…" (PRD §6.5). */
@Composable
fun etaText(seconds: Long?): String {
    if (seconds == null) return stringResource(R.string.android_estimating)
    val m = seconds / 60
    val time =
        when {
            m >= 60 -> str(R.string.product_eta_hm, "h" to m / 60, "m" to m % 60)
            m >= 1 -> str(R.string.product_eta_ms, "m" to m, "s" to seconds % 60)
            else -> str(R.string.product_eta_s, "s" to seconds)
        }
    return str(R.string.product_eta_left, "time" to time)
}

/** Catalog key (product.tx_err_*) to a string resource; Android wording where the Web's mentions tabs or browsers. */
@StringRes
fun errorRes(key: String?): Int = when (key) {
    "product.tx_err_unauthorized" -> R.string.product_tx_err_unauthorized
    "product.tx_err_storage_full" -> R.string.product_tx_err_storage_full
    "product.tx_err_storage" -> R.string.product_tx_err_storage_app
    "product.tx_err_sender_files" -> R.string.product_tx_err_sender_files_app
    "product.tx_err_checksum" -> R.string.product_tx_err_checksum
    "product.tx_err_protocol" -> R.string.product_tx_err_protocol
    else -> R.string.product_error_generic
}
