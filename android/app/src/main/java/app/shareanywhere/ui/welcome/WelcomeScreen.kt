package app.shareanywhere.ui.welcome

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import app.shareanywhere.R
import app.shareanywhere.ui.components.Logo
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.SaTokens

/**
 * ON-1 Welcome, shown once on first launch. Its only action, Start sharing, opens Transfer home; there is no
 * sign-in step (PRD §5.1). The design's "I want Clipboard Sync — sign in" link returns with accounts (6.4).
 */
@Composable
fun WelcomeScreen(onStart: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = SaTokens.Space.S6, vertical = SaTokens.Space.S6)
            .testTag(ScreenIds.WELCOME),
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S6)
    ) {
        // The message scrolls on its own at large font scales, so Start sharing always stays on screen.
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S4)
            ) {
                Logo(size = SaTokens.Space.S16)
                Text(
                    stringResource(R.string.android_vv_k130),
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() }
                )
                Text(
                    stringResource(R.string.product_welcome_android_p),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        Button(
            onClick = onStart,
            shape = CircleShape,
            modifier = Modifier.fillMaxWidth().heightIn(min = SaTokens.Control.Lg).testTag("welcome.start")
        ) {
            Text(stringResource(R.string.android_vv_k34), style = MaterialTheme.typography.labelLarge)
        }
    }
}
