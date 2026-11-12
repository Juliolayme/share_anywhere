package app.shareanywhere.ui.receive

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shareanywhere.R
import app.shareanywhere.qr.QrScanner
import app.shareanywhere.sharing.CODE_LENGTH
import app.shareanywhere.sharing.UiMessage
import app.shareanywhere.ui.components.FlowTopBar
import app.shareanywhere.ui.components.InlineNotice
import app.shareanywhere.ui.components.NoticeKind
import app.shareanywhere.ui.components.PrimaryButton
import app.shareanywhere.ui.components.SecondaryButton
import app.shareanywhere.ui.components.Tone
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.nav.ScreenIds
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens

/**
 * RX-1/RX-2 design screens `receive` (scan) and `receive-code`: a QR scanner (camera asked just in time, with denied
 * and unavailable states) and six-digit code entry with paste, inline validation and lookup errors (not found,
 * expired, locked out). Joining never asks for an account.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceiveScreen(onBack: () -> Unit, onNav: (ReceiveNav) -> Unit, viewModel: ReceiveViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    LaunchedEffect(viewModel) { viewModel.nav.collect(onNav) }
    Column(Modifier.fillMaxSize().testTag(if (ui.tab == ReceiveTab.Scan) ScreenIds.RECEIVE else ScreenIds.RECEIVE_CODE)) {
        FlowTopBar(stringResource(R.string.android_receive), R.drawable.ic_arrow_back, stringResource(R.string.product_back), onBack)
        PrimaryTabRow(selectedTabIndex = ui.tab.ordinal, containerColor = MaterialTheme.colorScheme.background) {
            Tab(
                selected = ui.tab == ReceiveTab.Scan,
                onClick = { viewModel.setTab(ReceiveTab.Scan) },
                text = { Text(stringResource(R.string.android_scan)) },
                modifier = Modifier.heightIn(min = SaTokens.Space.S12).testTag("receive.tab-scan")
            )
            Tab(
                selected = ui.tab == ReceiveTab.Code,
                onClick = { viewModel.setTab(ReceiveTab.Code) },
                text = { Text(stringResource(R.string.android_entercode)) },
                modifier = Modifier.heightIn(min = SaTokens.Space.S12).testTag("receive.tab-code")
            )
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(SaTokens.Space.S4),
            verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S4)
        ) {
            when (ui.tab) {
                ReceiveTab.Scan -> ScanTab(ui.busy, ui.error, onScanned = viewModel::openLink, onUseCode = {
                    viewModel.setTab(ReceiveTab.Code)
                })
                ReceiveTab.Code -> CodeTab(ui, viewModel::setCode, viewModel::submitCode)
            }
        }
    }
}

private enum class CameraState { Unknown, Granted, Ask, Denied, Unavailable }

@Composable
private fun ScanTab(busy: Boolean, error: UiMessage?, onScanned: (String) -> Unit, onUseCode: () -> Unit) {
    val context = LocalContext.current
    val p = LocalSaPalette.current
    var state by rememberSaveable {
        mutableStateOf(
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
            ) {
                CameraState.Granted
            } else {
                CameraState.Ask
            }
        )
    }
    var torch by rememberSaveable { mutableStateOf(false) }
    val launcher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            state =
                when {
                    granted -> CameraState.Granted
                    // Denied for good ("Don't ask again" or twice): only Android settings can turn it back on.
                    context is Activity &&
                        !ActivityCompat.shouldShowRequestPermissionRationale(
                            context,
                            Manifest.permission.CAMERA
                        ) -> CameraState.Denied
                    else -> CameraState.Ask
                }
        }
    // The last scanned text, so one code held in front of the camera is looked up once.
    var last by remember { mutableStateOf<String?>(null) }

    when (state) {
        CameraState.Granted ->
            Box(
                Modifier.fillMaxWidth().aspectRatio(
                    1f
                ).clip(RoundedCornerShape(SaTokens.Radius.Xl)).background(p.toast).testTag("receive.viewfinder"),
                contentAlignment = Alignment.Center
            ) {
                val desc = stringResource(R.string.product_scan_viewfinder)
                QrScanner(
                    active = !busy,
                    torch = torch,
                    onResult = { text ->
                        if (text != last) {
                            last = text
                            onScanned(text)
                        }
                    },
                    onUnavailable = { state = CameraState.Unavailable },
                    modifier = Modifier.fillMaxSize().semantics { contentDescription = desc }
                )
                Box(
                    Modifier.fillMaxWidth(
                        0.62f
                    ).aspectRatio(1f).border(SaTokens.Border.Focus, p.onSend, RoundedCornerShape(SaTokens.Radius.Lg))
                )
            }
        CameraState.Ask, CameraState.Unknown ->
            CameraCard(
                R.drawable.ic_photo_camera,
                stringResource(R.string.product_camera_needed_h),
                stringResource(R.string.product_camera_needed_p)
            ) {
                PrimaryButton(stringResource(R.string.product_camera_allow), {
                    launcher.launch(Manifest.permission.CAMERA)
                }, Modifier.testTag("receive.allow-camera"))
            }
        CameraState.Denied ->
            CameraCard(
                R.drawable.ic_no_photography,
                stringResource(R.string.product_camera_denied_h),
                stringResource(R.string.product_camera_denied_p)
            ) {
                SecondaryButton(stringResource(R.string.product_open_settings), {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                    )
                }, Modifier.fillMaxWidth())
            }
        CameraState.Unavailable ->
            InlineNotice(NoticeKind.Warning, R.drawable.ic_no_photography, stringResource(R.string.product_camera_unavailable))
    }
    Text(
        stringResource(R.string.product_scan_point),
        style = MaterialTheme.typography.bodySmall,
        color = p.fg2,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth()
    )
    error?.let { ErrorLine(it, Modifier.testTag("receive.error")) }
    Row(horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2), verticalAlignment = Alignment.CenterVertically) {
        if (state == CameraState.Granted) {
            IconButton(onClick = { torch = !torch }, modifier = Modifier.size(SaTokens.Space.S12)) {
                Icon(
                    painterResource(if (torch) R.drawable.ic_flashlight_off else R.drawable.ic_flashlight_on),
                    contentDescription = stringResource(if (torch) R.string.product_torch_off else R.string.product_torch_on)
                )
            }
        }
        SecondaryButton(stringResource(R.string.product_scan_code_instead), onUseCode, Modifier.weight(1f).testTag("receive.use-code"))
    }
}

@Composable
private fun CameraCard(icon: Int, title: String, body: String, action: @Composable () -> Unit) {
    val p = LocalSaPalette.current
    Column(
        Modifier.fillMaxWidth().clip(
            RoundedCornerShape(SaTokens.Radius.Xl)
        ).background(MaterialTheme.colorScheme.surface).padding(SaTokens.Space.S6),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S3)
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = p.fg2, modifier = Modifier.size(SaTokens.Space.S12))
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodySmall, color = p.fg2, textAlign = TextAlign.Center)
        action()
    }
}

@Composable
private fun CodeTab(ui: ReceiveUi, onCode: (String) -> Unit, onSubmit: () -> Unit) {
    val p = LocalSaPalette.current
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Text(stringResource(R.string.product_code_enter_p), style = MaterialTheme.typography.bodyMedium)
    val aria = stringResource(R.string.product_code_digits_aria)
    BasicTextField(
        value = TextFieldValue(ui.code, TextRange(ui.code.length)),
        onValueChange = { onCode(it.text) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { onSubmit() }),
        singleLine = true,
        modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = aria }.testTag("receive.code-input"),
        decorationBox = { inner ->
            Box {
                // The real field stays in the tree for IME, paste and TalkBack; the boxes show the digits.
                Box(Modifier.size(SaTokens.Border.Thin)) { inner() }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                    repeat(CODE_LENGTH) { i ->
                        val d = ui.code.getOrNull(i)
                        val current = i == ui.code.length
                        Box(
                            Modifier
                                .weight(1f)
                                .heightIn(min = SaTokens.Space.S12 + SaTokens.Space.S3)
                                .clip(RoundedCornerShape(SaTokens.Radius.Md))
                                .background(MaterialTheme.colorScheme.surface)
                                .border(
                                    if (current) SaTokens.Border.Focus else SaTokens.Border.Thin,
                                    if (ui.error != null) {
                                        p.danger
                                    } else if (current) {
                                        p.focus
                                    } else {
                                        p.borderStrong
                                    },
                                    RoundedCornerShape(SaTokens.Radius.Md)
                                ),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(d?.toString() ?: "", style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
        }
    )
    ui.error?.let { ErrorLine(it, Modifier.testTag("receive.error")) }
    Text(
        stringResource(R.string.common_cx_hint),
        style = MaterialTheme.typography.bodySmall,
        color = p.fg2,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth()
    )
    PrimaryButton(
        stringResource(R.string.android_cont),
        onSubmit,
        Modifier.testTag("receive.continue"),
        tone = Tone.Receive,
        enabled = ui.complete,
        busy = ui.busy
    )
}

@Composable
private fun ErrorLine(m: UiMessage, modifier: Modifier = Modifier) {
    val p = LocalSaPalette.current
    Row(
        modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive },
        horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            painterResource(R.drawable.ic_error),
            contentDescription = null,
            tint = p.dangerInk,
            modifier = Modifier.size(SaTokens.Space.S4)
        )
        Text(str(m.id, *m.args.toList().toTypedArray()), style = MaterialTheme.typography.bodySmall, color = p.dangerInk)
    }
}
