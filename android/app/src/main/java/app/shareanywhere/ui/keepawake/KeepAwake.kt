package app.shareanywhere.ui.keepawake

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

val LocalKeepAwake = staticCompositionLocalOf<KeepAwakeController> { error("LocalKeepAwake not provided") }

/** Holds the keep-awake controller while [needs] is true and this screen is composed; leaving the screen releases it. */
@Composable
fun rememberKeepAwake(needs: Boolean): PillState {
    val controller = LocalKeepAwake.current
    val key = remember { Any() }
    DisposableEffect(controller, needs) {
        controller.hold(key, needs)
        onDispose { controller.hold(key, false) }
    }
    val pill by controller.pill.collectAsStateWithLifecycle()
    return pill
}

/**
 * Applies the controller to the Activity window with View.keepScreenOn (FLAG_KEEP_SCREEN_ON, §7.2). Placed once at
 * the root; the flag is cleared when nothing needs it and when this leaves composition.
 */
@Composable
fun KeepScreenOnEffect(controller: KeepAwakeController) {
    val on by controller.screenOn.collectAsStateWithLifecycle()
    val view = LocalView.current
    DisposableEffect(view, on) {
        view.keepScreenOn = on
        onDispose { view.keepScreenOn = false }
    }
}

/**
 * Keep-open banner with the screen-on pill (docs/ARCHITECTURE.md §7.3, design `showKeep`): shown on every send,
 * receive and waiting screen. [onTurnSettingOn] runs when the pill says the setting is off and is tapped.
 */
@Composable
fun KeepOpenBanner(state: PillState, onTurnSettingOn: () -> Unit, modifier: Modifier = Modifier) {
    val p = LocalSaPalette.current
    val controller = LocalKeepAwake.current
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(SaTokens.Radius.Lg))
            .background(p.sendSoft)
            .padding(start = SaTokens.Space.S3, end = SaTokens.Space.S2, top = SaTokens.Space.S2, bottom = SaTokens.Space.S2)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("keep-open-banner"),
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            painterResource(R.drawable.ic_phonelink_lock),
            contentDescription = null,
            tint = p.sendInk,
            modifier = Modifier.size(SaTokens.Space.S6)
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
            Text(stringResource(R.string.android_keep), style = MaterialTheme.typography.bodySmall, color = p.fg)
            ScreenOnPill(state, onClick = { if (controller.tap()) onTurnSettingOn() })
        }
    }
}

@Composable
private fun ScreenOnPill(state: PillState, onClick: () -> Unit) {
    val p = LocalSaPalette.current
    val on = state == PillState.On
    val interactive = state != PillState.Paused
    val label =
        stringResource(
            when (state) {
                PillState.On -> R.string.android_xx_wake_on
                PillState.Off -> R.string.android_xx_wake_off
                PillState.Paused -> R.string.android_xx_wake_paused
                PillState.SetOff -> R.string.android_xx_wake_setoff
            }
        )
    // 48 dp touch target around the 28 dp pill (DESIGN_SYSTEM §5).
    Surface(
        onClick = onClick,
        enabled = interactive,
        shape = CircleShape,
        color = if (on) p.surface else Color.Transparent,
        border = BorderStroke(SaTokens.Border.Thin, if (on) p.send else p.fg3),
        modifier =
        Modifier
            .heightIn(min = SaTokens.Space.S12)
            .padding(vertical = SaTokens.Space.S2)
            .semantics {
                role = Role.Switch
                toggleableState = if (on) ToggleableState.On else ToggleableState.Off
                stateDescription = label
                if (!interactive) disabled()
            }
            .testTag("screen-on-pill")
    ) {
        Row(
            Modifier.padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)
        ) {
            Icon(
                painterResource(if (on) R.drawable.ic_light_mode else R.drawable.ic_brightness_low),
                contentDescription = null,
                tint = if (on) p.sendInk else p.fg2,
                modifier = Modifier.size(SaTokens.Space.S4)
            )
            Text(label, style = MaterialTheme.typography.labelMedium, color = if (on) p.sendInk else p.fg2)
        }
    }
}
