package app.shareanywhere.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import app.shareanywhere.R
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

private val CardShape = RoundedCornerShape(SaTokens.Radius.Lg)

/** Tab screen title row (design: 56 dp high, bold title, optional trailing action). */
@Composable
fun ScreenHeader(title: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().heightIn(min = SaTokens.Space.S12 + SaTokens.Space.S2),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            title,
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.weight(1f).semantics { heading() }
        )
        trailing?.invoke()
    }
}

/** Surface card used by lists and settings groups. */
@Composable
fun SaCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxWidth().clip(CardShape).background(MaterialTheme.colorScheme.surface),
        content = content
    )
}

/** Section label above a settings group. */
@Composable
fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier =
        Modifier
            .padding(start = SaTokens.Space.S1, top = SaTokens.Space.S4, bottom = SaTokens.Space.S2)
            .semantics { heading() }
    )
}

enum class NoticeKind { Info, Warning, Error }

/** Inline banner (design: role=status card with icon, title, body, optional action). Text and icon carry meaning, not colour alone. */
@Composable
fun InlineNotice(
    kind: NoticeKind,
    @DrawableRes icon: Int,
    title: String,
    modifier: Modifier = Modifier,
    body: String? = null,
    action: (@Composable () -> Unit)? = null,
    onDismiss: (() -> Unit)? = null
) {
    val p = LocalSaPalette.current
    val (bg, ink) =
        when (kind) {
            NoticeKind.Info -> p.sendSoft to p.sendInk
            NoticeKind.Warning -> p.warningSoft to p.warningInk
            NoticeKind.Error -> p.dangerSoft to p.dangerInk
        }
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(SaTokens.Radius.Lg))
            .background(bg)
            .padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S3),
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3),
        verticalAlignment = Alignment.Top
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = ink, modifier = Modifier.size(SaTokens.Space.S6))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = ink)
            if (body != null) Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
            if (action != null) action()
        }
        if (onDismiss != null) {
            IconButton(onClick = onDismiss) {
                Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.android_yy_close), tint = ink)
            }
        }
    }
}

/** Empty state (design: dashed outline, icon tile, title, body). */
@Composable
fun EmptyState(@DrawableRes icon: Int, title: String, body: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .border(SaTokens.Border.Thin, MaterialTheme.colorScheme.outline, CardShape)
            .padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S8),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
    ) {
        Box(
            Modifier
                .size(SaTokens.Space.S12)
                .clip(RoundedCornerShape(SaTokens.Radius.Lg))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center
        ) {
            Icon(painterResource(icon), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            body,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center
        )
    }
}

/** Loading placeholder rows (design skeleton). Hidden from TalkBack except for the busy label. */
@Composable
fun SkeletonList(rows: Int, label: String, modifier: Modifier = Modifier) {
    val p = LocalSaPalette.current
    Column(
        modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(MaterialTheme.colorScheme.surface)
            .padding(SaTokens.Space.S3)
            .semantics(mergeDescendants = true) { this.contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        repeat(rows) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = SaTokens.Control.Md)
                    .clip(RoundedCornerShape(SaTokens.Radius.Md))
                    .background(p.track)
            )
        }
    }
}

/** A tappable settings row: label, optional current value, chevron. At least 48 dp high. */
@Composable
fun SettingsRow(
    label: String,
    modifier: Modifier = Modifier,
    value: String? = null,
    description: String? = null,
    onClick: (() -> Unit)? = null
) {
    val clickable = if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = SaTokens.TouchTarget + SaTokens.Space.S2)
            .then(clickable)
            .padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            if (description != null) {
                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (value != null) {
            Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (onClick != null) {
            Icon(
                painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** A settings row with a switch; the whole row toggles (one TalkBack target with the switch state). */
@Composable
fun SwitchRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null,
    enabled: Boolean = true
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = SaTokens.TouchTarget + SaTokens.Space.S2)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(horizontal = SaTokens.Space.S4, vertical = SaTokens.Space.S3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            if (description != null) {
                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

/** Divider between rows of a card. */
@Composable
fun RowDivider() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = SaTokens.Space.S4)
            .heightIn(min = SaTokens.Border.Thin)
            .background(MaterialTheme.colorScheme.outlineVariant)
    )
}

/** One option of a [ChoiceSheet]. */
data class Choice<T>(val value: T, val label: String, val description: String? = null)

/** Bottom sheet with a radio group (design `pick` sheet for theme, language, retention). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> ChoiceSheet(title: String, options: List<Choice<T>>, selected: T, onSelect: (T) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = SaTokens.Space.S6)) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                modifier =
                Modifier
                    .padding(horizontal = SaTokens.Space.S6, vertical = SaTokens.Space.S2)
                    .semantics { heading() }
            )
            Column(Modifier.selectableGroup()) {
                for (o in options) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = SaTokens.TouchTarget + SaTokens.Space.S2)
                            .selectable(selected = o.value == selected, role = Role.RadioButton, onClick = { onSelect(o.value) })
                            .padding(horizontal = SaTokens.Space.S6),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        RadioButton(selected = o.value == selected, onClick = null)
                        Spacer(Modifier.width(SaTokens.Space.S3))
                        Column {
                            Text(o.label, style = MaterialTheme.typography.bodyLarge)
                            if (o.description != null) {
                                Text(
                                    o.description,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Confirmation dialog; [danger] colours the confirm action as destructive. */
@Composable
fun ConfirmDialog(title: String, body: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit, danger: Boolean = true) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("dialog.confirm")) {
                Text(confirm, color = if (danger) MaterialTheme.colorScheme.error else Color.Unspecified)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.android_yy_cancel)) } }
    )
}

/** Small status pill: icon plus label, never colour alone (design `chip`). */
@Composable
fun StatusPill(@DrawableRes icon: Int, label: String, background: Color, foreground: Color, modifier: Modifier = Modifier) {
    Row(
        modifier
            .clip(CircleShape)
            .background(background)
            .padding(horizontal = SaTokens.Space.S2, vertical = SaTokens.Space.S1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = foreground, modifier = Modifier.size(SaTokens.Space.S4))
        Text(label, style = MaterialTheme.typography.labelMedium, color = foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
