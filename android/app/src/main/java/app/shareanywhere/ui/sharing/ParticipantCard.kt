package app.shareanywhere.ui.sharing

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import app.shareanywhere.R
import app.shareanywhere.data.api.Participant
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.components.StatusPill
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

private val MOBILE = Regex("android|iphone|ios|mobile", RegexOption.IGNORE_CASE)

/** Device icon for a platform label ("Android · Pixel 7", "Chrome on Windows"). */
fun platformIcon(platform: String): Int = if (MOBILE.containsMatchIn(platform)) R.drawable.ic_smartphone else R.drawable.ic_laptop_windows

/** Guest / Signed in badge (PRD §5.3: the sender sees whether a receiver is signed in). */
@Composable
fun IdentityBadge(signedIn: Boolean) {
    val p = LocalSaPalette.current
    StatusPill(
        if (signedIn) R.drawable.ic_verified_user else R.drawable.ic_person,
        stringResource(if (signedIn) R.string.product_badge_signed_in else R.string.product_badge_guest),
        if (signedIn) p.sendSoft else p.surface2,
        if (signedIn) p.sendInk else p.fg2
    )
}

/** The three security words both sides compare (docs/SECURITY_MODEL.md §3.1). */
@Composable
fun SecurityWords(words: List<String>?, label: String, modifier: Modifier = Modifier) {
    if (words.isNullOrEmpty()) return
    val p = LocalSaPalette.current
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(SaTokens.Radius.Md))
            .background(p.receiveSoft)
            .padding(horizontal = SaTokens.Space.S3, vertical = SaTokens.Space.S2)
            .semantics(mergeDescendants = true) { },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
    ) {
        Icon(
            painterResource(R.drawable.ic_shield),
            contentDescription = null,
            tint = p.receiveInk,
            modifier = Modifier.size(SaTokens.Space.S4)
        )
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = p.fg2)
            Text(
                words.joinToString(" · "),
                style = MaterialTheme.typography.titleSmall,
                fontFamily = FontFamily.Monospace,
                color = p.fg,
                modifier = Modifier.testTag("security-words")
            )
        }
    }
}

/**
 * Participant card (DESIGN_SYSTEM ParticipantCard, design `session` receivers and requests): a joined receiver with
 * security words, Remove and Block, or a join request with Approve, Reject and Block.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun ParticipantCard(
    r: Participant,
    busy: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onRemove: () -> Unit,
    onBlock: () -> Unit,
    extra: @Composable () -> Unit = {}
) {
    val p = LocalSaPalette.current
    val requested = r.status == "REQUESTED"
    val shape = RoundedCornerShape(SaTokens.Radius.Lg)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (requested) p.sendSoft else p.surface)
            .border(SaTokens.Border.Thin, if (requested) p.send else p.border, shape)
            .padding(SaTokens.Space.S3)
            .semantics { contentDescription = r.displayName }
            .testTag(if (requested) "request-card" else "participant-card"),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)) {
            Box(
                Modifier.size(
                    SaTokens.Space.S8 + SaTokens.Space.S2
                ).clip(RoundedCornerShape(SaTokens.Radius.Md)).background(if (requested) p.surface else p.surface2),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    painterResource(platformIcon(r.platform)),
                    contentDescription = null,
                    tint = p.fg2,
                    modifier = Modifier.size(SaTokens.Space.S6)
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2),
                    verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S1)
                ) {
                    Text(r.displayName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    IdentityBadge(r.signedIn)
                }
                val via =
                    when {
                        requested -> stringResource(R.string.android_lbl_pending)
                        r.joinedVia == "code" -> stringResource(R.string.product_via_code)
                        r.joinedVia == "link" -> stringResource(R.string.product_via_link)
                        else -> null
                    }
                Text(listOfNotNull(r.platform, via).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = p.fg2)
            }
        }
        SecurityWords(r.securityWords, stringResource(R.string.android_xx_secw_s))
        extra()
        val approveLabel = str(R.string.product_approve_named, "name" to r.displayName)
        val rejectLabel = str(R.string.product_reject_named, "name" to r.displayName)
        val removeLabel = str(R.string.product_remove_confirm, "name" to r.displayName)
        val blockLabel = str(R.string.product_block_named, "name" to r.displayName)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)
        ) {
            if (requested) {
                PrimaryButton(
                    stringResource(R.string.android_approve),
                    onApprove,
                    Modifier.weight(1f).semantics { contentDescription = approveLabel }.testTag("participant.approve"),
                    busy = busy,
                    icon = R.drawable.ic_check
                )
                SecondaryButton(
                    stringResource(R.string.android_reject),
                    onReject,
                    Modifier.weight(1f).semantics { contentDescription = rejectLabel }.testTag("participant.reject"),
                    enabled = !busy
                )
            } else {
                TextButton(
                    onClick = onRemove,
                    enabled = !busy,
                    modifier = Modifier.semantics {
                        contentDescription = removeLabel
                    }.testTag("participant.remove")
                ) {
                    Icon(
                        painterResource(R.drawable.ic_person_remove),
                        contentDescription = null,
                        modifier = Modifier.size(SaTokens.Space.S4)
                    )
                    Text(" " + stringResource(R.string.android_yy_remove))
                }
            }
            TextButton(
                onClick = onBlock,
                enabled = !busy,
                modifier = Modifier.semantics {
                    contentDescription = blockLabel
                }.testTag("participant.block")
            ) {
                Icon(
                    painterResource(R.drawable.ic_block),
                    contentDescription = null,
                    tint = p.dangerInk,
                    modifier = Modifier.size(SaTokens.Space.S4)
                )
                Text(" " + stringResource(R.string.product_block), color = p.dangerInk)
            }
        }
    }
}
