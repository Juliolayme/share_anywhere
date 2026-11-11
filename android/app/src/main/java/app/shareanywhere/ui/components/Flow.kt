package app.shareanywhere.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

/** Flow screen app bar (design: 64 dp, 48 dp icon button, title). */
@Composable
fun FlowTopBar(
    title: String,
    @DrawableRes navIcon: Int,
    navLabel: String,
    onNav: () -> Unit,
    modifier: Modifier = Modifier,
    trailing: @Composable (() -> Unit)? = null
) {
    Row(
        modifier.fillMaxWidth().heightIn(min = SaTokens.Space.S16).padding(horizontal = SaTokens.Space.S1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)
    ) {
        IconButton(onClick = onNav, modifier = Modifier.size(SaTokens.Space.S12)) {
            Icon(painterResource(navIcon), contentDescription = navLabel)
        }
        Text(
            title,
            style = MaterialTheme.typography.titleLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() }
        )
        trailing?.invoke()
    }
}

enum class Tone { Send, Receive, Neutral, Danger }

/** Full-width pill button (design 56 dp primary actions); shows a spinner while [busy]. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tone: Tone = Tone.Send,
    enabled: Boolean = true,
    busy: Boolean = false,
    @DrawableRes icon: Int? = null
) {
    val p = LocalSaPalette.current
    val (bg, fg) =
        when (tone) {
            Tone.Send -> p.send to p.onSend
            Tone.Receive -> p.receive to p.onReceive
            Tone.Neutral -> p.surface2 to p.fg
            Tone.Danger -> p.danger to p.onSend
        }
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = bg,
            contentColor = fg,
            disabledContainerColor = p.track,
            disabledContentColor = p.fg3
        ),
        modifier = modifier.fillMaxWidth().heightIn(min = SaTokens.Space.S12 + SaTokens.Space.S2)
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(SaTokens.Space.S4), color = fg, strokeWidth = SaTokens.Border.Focus)
        } else if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(SaTokens.Space.S4 + SaTokens.Space.S1))
        }
        if (busy || icon != null) androidx.compose.foundation.layout.Spacer(Modifier.size(SaTokens.Space.S2))
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

/** Outlined pill button for secondary actions (48 dp). */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    @DrawableRes icon: Int? = null
) {
    val p = LocalSaPalette.current
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = CircleShape,
        border = androidx.compose.foundation.BorderStroke(SaTokens.Border.Thin, p.borderStrong),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = p.fg),
        modifier = modifier.heightIn(min = SaTokens.Space.S12)
    ) {
        if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(SaTokens.Space.S4 + SaTokens.Space.S1))
            androidx.compose.foundation.layout.Spacer(Modifier.size(SaTokens.Space.S2))
        }
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}
