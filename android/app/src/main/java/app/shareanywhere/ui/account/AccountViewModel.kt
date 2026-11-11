package app.shareanywhere.ui.account

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shareanywhere.R
import app.shareanywhere.account.AccountManager
import app.shareanywhere.account.AccountState
import app.shareanywhere.account.crypto.CryptoException
import app.shareanywhere.account.crypto.KeyFlows
import app.shareanywhere.account.crypto.Phrase
import app.shareanywhere.account.keys.AccountKeys
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.data.api.AccountDevice
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.NetworkException
import app.shareanywhere.history.HistoryRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** A message for the UI: a string resource and its `{name}` arguments. */
data class UiText(@StringRes val id: Int, val args: Map<String, String> = emptyMap())

/** Maps account and key errors to the Web's messages (docs/UX_SCREEN_MAP.md §9 "As built"). */
fun accountError(e: Throwable): UiText = when {
    e is NetworkException -> UiText(R.string.product_acct_offline)
    e is ApiException && e.code == "invalid_credentials" -> UiText(R.string.product_acct_invalid_credentials)
    e is ApiException && e.code == "email_taken" -> UiText(R.string.product_acct_email_taken)
    e is ApiException && e.code == "weak_password" -> UiText(R.string.product_acct_weak_password)
    e is ApiException && e.code == "already_signed_in" -> UiText(R.string.product_acct_already_signed_in_device)
    e is ApiException && e.code == "keys_exist" -> UiText(R.string.product_key_exists)
    e is ApiException && e.code == "pairing_not_found" -> UiText(R.string.product_pair_not_found)
    e is ApiException && e.status == 404 -> UiText(R.string.product_pair_not_found)
    e is ApiException && e.status == 429 -> UiText(R.string.product_acct_rate_limited)
    e is CryptoException && e.code == "untrusted_sender" -> UiText(R.string.product_pair_untrusted)
    e is CryptoException && e.code == "invalid_phrase" -> UiText(R.string.product_phrase_checksum)
    e is CryptoException && e.code == "decrypt_failed" -> UiText(R.string.product_phrase_wrong)
    e is CryptoException && e.code == "recovery_unverified" -> UiText(R.string.product_phrase_unverified)
    e is CryptoException && e.code == "unverified" -> UiText(R.string.product_key_change_unverified)
    e is CryptoException && e.code == "keys_legacy" -> UiText(R.string.product_keys_legacy)
    else -> UiText(R.string.product_error_generic)
}

private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

fun validEmail(email: String) = EMAIL.matches(email.trim()) && email.trim().length <= 254

/** Sign-up password check (backend: 10 to 128 characters; the server also refuses common and email-derived passwords). */
@StringRes
fun passwordProblem(pw: String, signUp: Boolean): Int? = when {
    pw.isEmpty() -> R.string.product_password_required
    signUp && pw.length < 10 -> R.string.product_password_short
    else -> null
}

/** 0 weak … 3 strong, the Web's rough meter (length and character classes). */
fun passwordStrength(pw: String): Int {
    val classes = listOf(
        pw.any {
            it.isLowerCase()
        },
        pw.any { it.isUpperCase() },
        pw.any { it.isDigit() },
        pw.any { !it.isLetterOrDigit() }
    ).count { it }
    return when {
        pw.length < 10 -> 0
        pw.length >= 16 && classes >= 3 -> 3
        classes >= 3 || pw.length >= 14 -> 2
        else -> 1
    }
}

/** AC-6 pairing on this (new) device. */
sealed interface PairState {
    data object Starting : PairState

    data class Waiting(val payload: String, val expiresAt: String) : PairState

    data object Expired : PairState

    data class Failed(val message: UiText) : PairState

    data object Done : PairState
}

/** "Pair a new device" on a ready device: find the code, confirm the name, send the key. */
sealed interface SendKeyState {
    data object Idle : SendKeyState

    data object Finding : SendKeyState

    data class Confirm(val found: AccountKeys.CodeLookup) : SendKeyState

    data object Sending : SendKeyState

    data class Sent(val name: String) : SendKeyState

    data class Failed(val message: UiText) : SendKeyState
}

/**
 * The account screens (AC-1…AC-8), Devices and Settings account sections. Every action goes through [AccountManager]
 * (one per process), so all screens see the same account state.
 */
@HiltViewModel
class AccountViewModel
@Inject
constructor(private val account: AccountManager, private val history: HistoryRepository) : ViewModel() {
    val state: StateFlow<AccountState> = account.state
    val hasHistory: StateFlow<Boolean> = history.observeAll().map { it.isNotEmpty() }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _error = MutableStateFlow<UiText?>(null)
    val error: StateFlow<UiText?> = _error.asStateFlow()

    fun clearError() {
        _error.value = null
    }

    private fun run(block: suspend () -> Unit) {
        if (_busy.value) return
        _busy.value = true
        _error.value = null
        viewModelScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = accountError(e)
            } finally {
                _busy.value = false
            }
        }
    }

    // AC-1 / AC-2: sign in or create the account without adding the device; AC-4 follows.
    fun signIn(email: String, password: String, onDone: () -> Unit) = run {
        account.signIn(email, password, addDevice = false)
        onDone()
    }

    fun signUp(email: String, password: String, onDone: () -> Unit) = run {
        account.signUp(email, password, addDevice = false)
        onDone()
    }

    fun requestReset(email: String, onDone: () -> Unit) = run {
        account.requestReset(email)
        onDone()
    }

    /** AC-4 Continue: adds the device when chosen, then the key state picks AC-5, AC-6 or AC-8. */
    fun trustContinue(add: Boolean, copyHistory: Boolean, onNext: (KeyStatus) -> Unit) = run {
        if (!add) {
            onNext(KeyStatus.None)
            return@run
        }
        try {
            onNext(account.addThisDevice(copyHistory))
        } catch (e: ApiException) {
            if (e.code == "already_added") onNext(account.checkKeys()) else throw e
        }
    }

    fun addThisDevice(onNext: (KeyStatus) -> Unit) = run { onNext(account.addThisDevice(copyHistory = false)) }

    // AC-5
    private val _phrase = MutableStateFlow<String?>(null)
    val phrase: StateFlow<String?> = _phrase.asStateFlow()
    private var prepared: KeyFlows.PreparedSetup? = null

    /** Creates the key and the phrase on the device (shown once); the server learns nothing yet. */
    fun prepareKeys() {
        if (prepared != null) return
        run {
            val p = account.prepareKeys()
            prepared = p
            _phrase.value = p.phrase
        }
    }

    /** Continue: `POST /v1/keys/setup`, then the key is stored. `409 keys_exist` → AC-6. */
    fun commitKeys(onDone: () -> Unit, onKeysExist: () -> Unit) = run {
        val p = prepared ?: return@run
        try {
            account.commitKeys(p)
            prepared = null
            _phrase.value = null
            onDone()
        } catch (e: ApiException) {
            if (e.code == "keys_exist") {
                prepared = null
                _phrase.value = null
                onKeysExist()
            } else {
                throw e
            }
        }
    }

    override fun onCleared() {
        prepared?.discard()
        prepared = null
    }

    // AC-6 on the new device
    private val _pair = MutableStateFlow<PairState>(PairState.Starting)
    val pair: StateFlow<PairState> = _pair.asStateFlow()
    private var pairJob: Job? = null

    fun startPairing() {
        pairJob?.cancel()
        _pair.value = PairState.Starting
        pairJob =
            viewModelScope.launch {
                try {
                    val start = account.startPairing()
                    _pair.value = PairState.Waiting(start.payload, start.expiresAt)
                    while (true) {
                        delay(2_000)
                        val s =
                            try {
                                account.pairingStatus(start.pairingId)
                            } catch (e: NetworkException) {
                                continue
                            }
                        when (s.status) {
                            "ready" -> {
                                account.finishPairing(start, s)
                                _pair.value = PairState.Done
                                return@launch
                            }
                            "expired" -> {
                                _pair.value = PairState.Expired
                                return@launch
                            }
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiException) {
                    _pair.value = if (e.status == 404 || e.status == 410) PairState.Expired else PairState.Failed(accountError(e))
                } catch (e: Exception) {
                    _pair.value = PairState.Failed(if (e is CryptoException) accountError(e) else UiText(R.string.product_pair_failed))
                }
            }
    }

    fun pairingExpired() {
        if (_pair.value is PairState.Waiting) {
            pairJob?.cancel()
            _pair.value = PairState.Expired
        }
    }

    fun stopPairing() {
        pairJob?.cancel()
    }

    fun phraseProblem(text: String): UiText? {
        val words = Phrase.normalize(text).split(' ').filter { it.isNotEmpty() }
        if (words.size < 12) return null
        val p = Phrase.check(text) ?: return null
        return when (p.reason) {
            "unknown_word" -> UiText(R.string.product_phrase_unknown, mapOf("word" to p.word.orEmpty()))
            "checksum" -> UiText(R.string.product_phrase_checksum)
            else -> UiText(R.string.product_phrase_checksum)
        }
    }

    fun recover(phrase: String, onDone: () -> Unit) = run {
        account.recover(phrase)
        onDone()
    }

    // Pair a new device (on a ready device)
    private val _sendKey = MutableStateFlow<SendKeyState>(SendKeyState.Idle)
    val sendKey: StateFlow<SendKeyState> = _sendKey.asStateFlow()

    fun findCode(text: String) {
        if (_sendKey.value == SendKeyState.Finding) return
        _sendKey.value = SendKeyState.Finding
        viewModelScope.launch {
            _sendKey.value =
                try {
                    val found = account.lookupPairingCode(text.trim())
                    if (found == null) SendKeyState.Failed(UiText(R.string.product_pair_invalid)) else SendKeyState.Confirm(found)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    SendKeyState.Failed(
                        if (e is ApiException &&
                            e.status == 404
                        ) {
                            UiText(R.string.product_pair_not_found)
                        } else {
                            accountError(e)
                        }
                    )
                }
        }
    }

    fun confirmSend(found: AccountKeys.CodeLookup) {
        _sendKey.value = SendKeyState.Sending
        viewModelScope.launch {
            _sendKey.value =
                try {
                    account.sendKey(found)
                    SendKeyState.Sent(found.peer.deviceName)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    SendKeyState.Failed(accountError(e))
                }
        }
    }

    fun resetSendKey() {
        _sendKey.value = SendKeyState.Idle
    }

    // Settings / Devices
    fun signOut(clearHistory: Boolean, onDone: () -> Unit) = run {
        account.signOut(clearHistory)
        onDone()
    }

    fun setHistorySync(on: Boolean) = run { account.setHistorySync(on) }

    fun changePassword(current: String, next: String, onDone: () -> Unit) {
        if (_busy.value) return
        _busy.value = true
        _error.value = null
        viewModelScope.launch {
            try {
                account.changePassword(current, next)
                onDone()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _error.value =
                    if (e.code == "invalid_credentials" ||
                        e.code == "wrong_password"
                    ) {
                        UiText(R.string.product_chpw_wrong)
                    } else {
                        accountError(e)
                    }
            } catch (e: Exception) {
                _error.value = accountError(e)
            } finally {
                _busy.value = false
            }
        }
    }

    fun retryKeys() = viewModelScope.launch { account.checkKeys() }

    fun retryMe() = viewModelScope.launch { account.refreshMe() }

    fun syncNow() = viewModelScope.launch { account.syncNow() }

    // DV-1 account list
    private val _devices = MutableStateFlow<List<AccountDevice>?>(null)
    val devices: StateFlow<List<AccountDevice>?> = _devices.asStateFlow()
    private val _devicesError = MutableStateFlow(false)
    val devicesError: StateFlow<Boolean> = _devicesError.asStateFlow()

    fun loadDevices() = viewModelScope.launch {
        try {
            _devices.value =
                account.devices().sortedWith(compareByDescending<AccountDevice> { it.current }.thenByDescending { it.lastSeenAt })
            _devicesError.value = false
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _devicesError.value = true
        }
    }

    fun renameDevice(id: String, name: String, onDone: () -> Unit) = run {
        account.renameDevice(id, name.trim())
        loadDevices()
        onDone()
    }

    fun revokeDevice(id: String, onDone: () -> Unit) = run {
        account.revokeDevice(id)
        loadDevices()
        onDone()
    }
}
