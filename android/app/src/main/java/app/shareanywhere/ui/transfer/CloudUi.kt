package app.shareanywhere.ui.transfer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.R
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.CloudApi
import app.shareanywhere.data.api.CloudEstimate
import app.shareanywhere.data.api.CloudSettings
import app.shareanywhere.transfer.cloud.CloudUploadState
import app.shareanywhere.ui.components.RowDivider
import app.shareanywhere.ui.components.SaCard
import app.shareanywhere.ui.components.SettingsRow
import app.shareanywhere.ui.components.SwitchRow
import app.shareanywhere.ui.format.formatBytes
import app.shareanywhere.ui.i18n.str
import app.shareanywhere.ui.i18n.uiLocale
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.theme.SaTokens
import dagger.hilt.android.lifecycle.HiltViewModel
import java.text.NumberFormat
import java.util.Currency
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Cloud Distribution on Android (docs/TRANSFER_PROTOCOL.md §9, PRD §6.6): the TR-3 option with its consent dialog, the
 * upload card on the session screen, and the Settings section (Transfer strategy Auto, Cloud switch and budget).
 */
private const val GIB = 1024.0 * 1024 * 1024

private fun money(amount: Double, currency: String): String = runCatching {
    NumberFormat.getCurrencyInstance().apply {
        this.currency = Currency.getInstance(currency)
        maximumFractionDigits = 4
    }.format(amount)
}.getOrDefault("%.4f %s".format(amount, currency))

/** TR-3: hidden without server support; disabled with "Sign in to use Cloud transfer" for guests. */
@Composable
fun CloudSendOption(settings: CloudSettings?, on: Boolean, onToggle: (Boolean) -> Unit, error: String?) {
    if (settings == null || !settings.available) return
    SaCard {
        if (!settings.signedIn || !settings.deviceAdded) {
            SwitchRow(
                label = stringResource(R.string.product_cloud_option),
                checked = false,
                onCheckedChange = {},
                description = stringResource(if (!settings.signedIn) R.string.product_cloud_signin else R.string.product_cloud_add_device),
                enabled = false,
                modifier = Modifier.testTag("send.cloud")
            )
        } else {
            SwitchRow(
                label = stringResource(R.string.product_cloud_option),
                checked = on,
                onCheckedChange = onToggle,
                description = stringResource(R.string.product_cloud_option_p),
                modifier = Modifier.testTag("send.cloud")
            )
        }
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
}

/** The consent dialog: storage, receiver egress, retention, cost or "Cost unknown", this month's budget. */
@Composable
fun CloudConsentDialog(estimate: CloudEstimate?, busy: Boolean, onApprove: () -> Unit, onDismiss: () -> Unit) {
    val locale = LocalConfiguration.current.uiLocale()
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("cloud.consent"),
        title = { Text(stringResource(R.string.android_xx_cloud_h)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                Text(stringResource(R.string.android_xx_cloud_p))
                if (estimate == null) {
                    Text(stringResource(R.string.product_cloud_estimating))
                } else {
                    Text(str(R.string.product_cloud_storage, "size" to formatBytes(estimate.storageBytes, locale)))
                    Text(str(R.string.product_cloud_egress, "size" to formatBytes(estimate.egressBytes, locale)))
                    Text(str(R.string.product_cloud_retention, "hours" to estimate.retentionHours))
                    val cost = estimate.cost
                    Text(
                        if (cost == null) {
                            stringResource(R.string.product_cost_unknown)
                        } else {
                            str(R.string.product_cloud_cost, "amount" to money(cost, estimate.currency ?: "USD"))
                        },
                        modifier = Modifier.testTag("cloud.cost")
                    )
                    Text(
                        str(
                            R.string.product_cloud_budget_line,
                            "used" to formatBytes(estimate.usedBytes, locale),
                            "budget" to formatBytes(estimate.budgetBytes, locale)
                        ),
                        color = LocalSaPalette.current.fg2
                    )
                    if (!estimate.withinBudget) {
                        Text(
                            stringResource(R.string.product_cloud_over_budget),
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                }
                Text(stringResource(R.string.product_cloud_encrypted_p), style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            TextButton(
                onClick = onApprove,
                enabled = estimate?.withinBudget == true && !busy,
                modifier = Modifier.testTag("cloud.approve")
            ) {
                Text(stringResource(R.string.product_cloud_approve))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.android_yy_cancel)) } }
    )
}

/** Catalog text for an error key the uploader reports (R.string names). */
@Composable
private fun cloudErrorText(key: String): String = stringResource(
    when (key) {
        "product_cloud_budget_exhausted" -> R.string.product_cloud_budget_exhausted
        "product_cloud_consent_needed" -> R.string.product_cloud_consent_needed
        "product_cloud_signin" -> R.string.product_cloud_signin
        "product_cloud_unavailable" -> R.string.product_cloud_unavailable
        else -> R.string.product_cloud_upload_failed
    }
)

/** The sender's Cloud upload on the session screen. */
@Composable
fun CloudUploadCard(state: CloudUploadState) {
    val locale = LocalConfiguration.current.uiLocale()
    val total = state.files.sumOf { it.size }
    val done = state.files.sumOf { it.uploaded }
    val label =
        when {
            state.ready -> stringResource(R.string.product_cloud_ready)
            state.paused -> stringResource(R.string.product_cloud_paused)
            else -> str(R.string.product_cloud_uploading, "done" to formatBytes(done, locale), "total" to formatBytes(total, locale))
        }
    SaCard(
        Modifier
            .testTag("session.cloud")
            .semantics {
                contentDescription = if (state.ready) {
                    "ready"
                } else if (state.paused) {
                    "paused"
                } else {
                    "uploading"
                }
            }
    ) {
        Text(label, style = MaterialTheme.typography.titleSmall)
        if (!state.ready) {
            LinearProgressIndicator(
                progress = { if (total > 0) done.toFloat() / total else 0f },
                modifier = Modifier.fillMaxWidth()
            )
        }
        state.error?.let { Text(cloudErrorText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

/** Settings: Cloud Distribution for the signed-in account (consent once, budget, use). */
@HiltViewModel
class CloudSettingsViewModel
@Inject
constructor(private val api: CloudApi) : ViewModel() {
    private val _settings = MutableStateFlow<CloudSettings?>(null)
    val settings: StateFlow<CloudSettings?> = _settings.asStateFlow()
    private val _failed = MutableStateFlow(false)
    val failed: StateFlow<Boolean> = _failed.asStateFlow()

    fun load() {
        viewModelScope.launch { _settings.value = runCatching { api.settings() }.getOrNull() }
    }

    fun save(enabled: Boolean, consent: Boolean, budgetBytes: Long? = null) {
        viewModelScope.launch {
            try {
                _settings.value = api.putSettings(enabled, consent, budgetBytes)
                _failed.value = false
            } catch (e: ApiException) {
                _failed.value = true
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                _failed.value = true
            }
        }
    }
}

/** The Transfer strategy row (Auto, for everyone) and, when signed in, the Cloud Distribution rows. */
@Composable
fun CloudSettingsSection(viewModel: CloudSettingsViewModel = hiltViewModel()) {
    val settings by viewModel.settings.collectAsState()
    val failed by viewModel.failed.collectAsState()
    val locale = LocalConfiguration.current.uiLocale()
    var consenting by remember { mutableStateOf(false) }
    var budget by remember { mutableStateOf("") }
    var budgetError by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { viewModel.load() }
    LaunchedEffect(settings?.budgetBytes) { settings?.let { budget = "%.1f".format(it.budgetBytes / GIB) } }
    SaCard {
        SettingsRow(
            label = stringResource(R.string.android_yy_s_strategy),
            value = stringResource(R.string.android_yy_st_auto),
            description = stringResource(R.string.android_yy_st_auto_p),
            modifier = Modifier.testTag("settings.strategy")
        )
        val s = settings
        if (s != null && s.available && s.signedIn) {
            RowDivider()
            SwitchRow(
                label = stringResource(R.string.android_yy_s_cloud),
                checked = s.enabled,
                onCheckedChange = { on -> if (on && !s.consented) consenting = true else viewModel.save(on, false) },
                description = stringResource(if (s.deviceAdded) R.string.android_yy_s_cloud_p else R.string.product_cloud_add_device),
                enabled = s.deviceAdded,
                modifier = Modifier.testTag("settings.cloud")
            )
            if (s.enabled) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                    OutlinedTextField(
                        value = budget,
                        onValueChange = { budget = it },
                        label = { Text(stringResource(R.string.product_cloud_budget_gb)) },
                        isError = budgetError,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        modifier = Modifier.weight(1f).testTag("settings.cloud-budget")
                    )
                    TextButton(
                        onClick = {
                            val gb = budget.replace(',', '.').toDoubleOrNull()
                            budgetError = gb == null || gb < 0 || gb > s.maxBudgetBytes / GIB
                            if (!budgetError && gb != null) viewModel.save(true, false, (gb * GIB).toLong())
                        },
                        modifier = Modifier.testTag("settings.cloud-budget-save")
                    ) { Text(stringResource(R.string.product_cloud_budget_save)) }
                }
                if (budgetError) {
                    Text(
                        str(R.string.product_cloud_budget_invalid, "max" to (s.maxBudgetBytes / GIB).toLong()),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("settings.cloud-budget-error")
                    )
                }
                Text(
                    str(
                        R.string.product_cloud_budget_used,
                        "used" to formatBytes(s.usedBytes, locale),
                        "budget" to formatBytes(s.budgetBytes, locale)
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = LocalSaPalette.current.fg2
                )
            }
            if (failed) Text(stringResource(R.string.product_error_generic), color = MaterialTheme.colorScheme.error)
        }
    }
    if (consenting) {
        AlertDialog(
            onDismissRequest = { consenting = false },
            title = { Text(stringResource(R.string.android_xx_cloud_h)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(SaTokens.Space.S2)) {
                    Text(stringResource(R.string.product_cloud_consent_settings_p))
                    Text(stringResource(R.string.product_cloud_encrypted_p), style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    consenting = false
                    viewModel.save(true, true)
                }) { Text(stringResource(R.string.product_cloud_approve)) }
            },
            dismissButton = { TextButton(onClick = { consenting = false }) { Text(stringResource(R.string.android_yy_cancel)) } }
        )
    }
}
