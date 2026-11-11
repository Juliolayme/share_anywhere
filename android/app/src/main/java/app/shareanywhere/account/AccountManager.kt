package app.shareanywhere.account

import app.shareanywhere.account.crypto.KeyStore
import app.shareanywhere.account.keys.AccountKeys
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.account.sync.HistoryEndpoints
import app.shareanywhere.account.sync.HistoryMetaStore
import app.shareanywhere.account.sync.HistorySync
import app.shareanywhere.account.sync.LocalHistory
import app.shareanywhere.data.api.AccountApi
import app.shareanywhere.data.api.ApiException
import app.shareanywhere.data.api.HistoryEntryRequest
import app.shareanywhere.data.api.NetworkException
import app.shareanywhere.data.api.PairingStatus
import app.shareanywhere.history.HistoryEntry
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.history.HistorySyncHandler
import app.shareanywhere.identity.IdentityManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The account on this device (docs/UX_SCREEN_MAP.md §7–§9, PRD §2 "Signing in"); guests have none. */
data class AccountState(
    val signedIn: Boolean = false,
    val accountId: String? = null,
    val email: String? = null,
    /** Added to the account (`dl`): needed for keys, history sync and Clipboard Sync. */
    val added: Boolean = false,
    val deviceId: String? = null,
    val keys: KeyStatus = KeyStatus.None,
    val keyVersion: Int = 0,
    /** A rotation the server says is owed could not be made yet (Devices shows it). */
    val rotationOwed: Boolean = false,
    val historySync: Boolean = false,
    /** `GET /v1/me` failed (the account state on screen may be stale). */
    val meFailed: Boolean = false,
    val sync: HistorySyncState = HistorySyncState()
)

/** The last history sync pass (HI-1 banner: "Synced {when}", "Syncing…", error with Retry). */
data class HistorySyncState(
    val running: Boolean = false,
    /** Epoch ms of the last successful pass. */
    val at: Long? = null,
    val unreadable: Int = 0,
    val error: Boolean = false,
    val offline: Boolean = false
)

/**
 * Account sessions layered on the device identity (ADR 0002, ADR 0010): sign-up and sign-in keep the same device, sign-out
 * replaces it with a new anonymous one. Follows the token's `acct` claim: when the account session ends without a
 * sign-out here (revoked elsewhere, password reset, expiry), every account key and account record on the device is
 * erased. Runs key checks when signed in and added (on start, then every 30 s while the app is open).
 */
class AccountManager(
    private val identity: IdentityManager,
    private val api: AccountApi,
    private val keys: AccountKeys,
    private val history: HistoryRepository,
    private val historyMeta: HistoryMetaStore,
    private val scope: CoroutineScope,
    private val onAccountData: AccountDataHooks = AccountDataHooks(),
    private val foreground: () -> Boolean = { true }
) {
    private val _state = MutableStateFlow(AccountState())
    val state: StateFlow<AccountState> = _state.asStateFlow()
    private val checkLock = Mutex()
    private var ticker: Job? = null

    fun start() {
        scope.launch {
            identity.state.distinctUntilChangedBy { it.claims?.acct to it.claims?.dl }.collect { s ->
                val c = s.claims
                val prev = _state.value
                if (prev.signedIn && prev.accountId != null && prev.accountId != c?.acct) {
                    // The account session ended here or elsewhere: nothing of that account stays on the device.
                    wipeAccountData()
                }
                if (c?.acct == null) {
                    _state.value = AccountState(deviceId = c?.sub)
                    history.syncHandler = null
                    ticker?.cancel()
                } else {
                    _state.update {
                        it.copy(
                            signedIn = true,
                            accountId = c.acct,
                            added = c.dl,
                            deviceId = c.sub,
                            keys = if (c.dl) it.keys else KeyStatus.None
                        )
                    }
                    refreshMe()
                    if (c.dl) startTicker() else ticker?.cancel()
                }
            }
        }
    }

    private suspend fun wipeAccountData() {
        history.syncHandler = null
        keys.wipe()
        runCatching { historyMeta.wipe() }
        onAccountData.wipe()
    }

    /** Key check and, while history sync is on, a sync pass: on start, then every 30 s while the app is in front. */
    private fun startTicker() {
        if (ticker?.isActive == true) return
        ticker =
            scope.launch {
                var first = true
                while (isActive) {
                    if (first || foreground()) {
                        val status = checkKeys()
                        if (status == KeyStatus.Ready && (first || _state.value.historySync)) syncNow()
                    }
                    first = false
                    delay(30_000)
                }
            }
    }

    suspend fun refreshMe() {
        try {
            val me = api.me()
            _state.update { it.copy(email = me.email, historySync = me.historySync, added = me.device.added, meFailed = false) }
            updateSyncHandler()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(meFailed = true) }
        }
    }

    fun keyStore(accountId: String): KeyStore = keys.store(accountId)

    // --- History sync (PRD §2 History, docs/UX_SCREEN_MAP.md HI-1) ---

    private var syncing: Deferred<Unit>? = null

    private val historyEndpoints =
        object : HistoryEndpoints {
            override suspend fun historyEntries(after: Long) = api.historyEntries(after)

            override suspend fun addHistoryEntry(req: HistoryEntryRequest) = api.addHistoryEntry(req)

            override suspend fun deleteHistoryEntry(id: String) = api.deleteHistoryEntry(id)

            override suspend fun clearHistory() = api.clearHistory()
        }

    private val localHistory =
        object : LocalHistory {
            override suspend fun list(): List<HistoryEntry> = history.list()

            override suspend fun add(entry: HistoryEntry) = history.add(entry)

            override suspend fun remove(id: String) = history.removeLocal(id)
        }

    /** Local deletions tombstone the synced copies while history sync is on (queued when offline). */
    private fun updateSyncHandler() {
        val s = _state.value
        val acct = s.accountId
        history.syncHandler =
            if (acct == null || !s.added || !s.historySync) {
                null
            } else {
                object : HistorySyncHandler {
                    override fun removed(ids: List<String>) {
                        scope.launch { reportSync { HistorySync.deleteSynced(historyEndpoints, historyMeta, acct, ids) } }
                    }

                    override fun cleared() {
                        scope.launch { reportSync { HistorySync.clearSynced(historyEndpoints, historyMeta, acct) } }
                    }
                }
            }
    }

    private suspend fun reportSync(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(sync = it.sync.copy(error = true, offline = e is NetworkException)) }
        }
    }

    /**
     * One history sync pass (a pending "copy history" import runs even with sync off). Concurrent calls share one pass.
     * Runs only for an added device that holds the key.
     */
    suspend fun syncNow() {
        val s = _state.value
        val acct = s.accountId ?: return
        val dev = s.deviceId ?: return
        if (!s.added || s.keys != KeyStatus.Ready) return
        val run =
            syncing?.takeIf { it.isActive } ?: scope.async {
                _state.update { it.copy(sync = it.sync.copy(running = true)) }
                try {
                    val names = if (s.historySync) {
                        runCatching {
                            api.devices().devices.associate { it.id to it.name }
                        }.getOrDefault(emptyMap())
                    } else {
                        emptyMap()
                    }
                    val res =
                        HistorySync.sync(
                            HistorySync.Deps(
                                historyEndpoints,
                                keys.store(acct),
                                localHistory,
                                historyMeta,
                                acct,
                                dev,
                                enabled = s.historySync,
                                deviceNames = names,
                                onKeyConflict = { checkKeys() }
                            )
                        )
                    _state.update { it.copy(sync = HistorySyncState(at = System.currentTimeMillis(), unreadable = res.unreadable)) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _state.update { it.copy(sync = it.sync.copy(running = false, error = true, offline = e is NetworkException)) }
                }
            }.also { syncing = it }
        run.await()
    }

    /** A key check (pickup, re-proof, chain import, owed rotation); the state shows the result. */
    suspend fun checkKeys(): KeyStatus = checkLock.withLock {
        val s = _state.value
        val acct = s.accountId ?: return KeyStatus.None
        val dev = s.deviceId ?: return KeyStatus.None
        if (!s.added) return KeyStatus.None
        if (s.keys == KeyStatus.None) _state.update { it.copy(keys = KeyStatus.Checking) }
        return try {
            val check = keys.check(acct, dev)
            _state.update { it.copy(keys = check.status, keyVersion = check.keyVersion, rotationOwed = check.rotationOwed) }
            if (check.newVersions.isNotEmpty()) {
                onAccountData.keysChanged()
                if (check.status == KeyStatus.Ready) scope.launch { syncNow() }
            }
            check.status
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            _state.update { it.copy(keys = if (it.keys == KeyStatus.Checking) KeyStatus.Error else it.keys) }
            KeyStatus.Error
        }
    }

    suspend fun signUp(email: String, password: String, addDevice: Boolean) {
        val r = api.signUp(email.trim(), password, addDevice)
        identity.adoptToken(r.accessToken, r.expiresIn)
        _state.update { it.copy(email = r.account.email) }
    }

    suspend fun signIn(email: String, password: String, addDevice: Boolean) {
        val r = api.signIn(email.trim(), password, addDevice)
        identity.adoptToken(r.accessToken, r.expiresIn)
        _state.update { it.copy(email = r.account.email) }
    }

    /** AC-4 "Add this device" after a short sign-in; returns the key state that decides the next screen. */
    suspend fun addThisDevice(copyHistory: Boolean): KeyStatus {
        val t = api.addCurrent(copyHistory)
        _state.value.accountId?.let { acct ->
            runCatching { historyMeta.put(historyMeta.get(acct).copy(pushSince = System.currentTimeMillis(), importPending = copyHistory)) }
        }
        identity.adoptToken(t.accessToken, t.expiresIn)
        // The identity flow updates the state; wait for it, then check the key.
        repeat(50) {
            if (_state.value.added) return checkKeys()
            delay(20)
        }
        return checkKeys()
    }

    /**
     * AC-7 sign-out: a new anonymous identity replaces this device; account keys and records are erased; local History
     * stays unless [clearHistory] (PRD §2).
     */
    suspend fun signOut(clearHistory: Boolean) {
        val session = api.signOut()
        wipeAccountData()
        if (clearHistory) history.clear(sync = false)
        identity.replaceSession(session)
    }

    suspend fun requestReset(email: String) = api.requestReset(email.trim())

    suspend fun setHistorySync(on: Boolean) {
        val me = api.setHistorySync(on)
        _state.update { it.copy(historySync = me.historySync) }
        updateSyncHandler()
        if (me.historySync) scope.launch { syncNow() }
    }

    suspend fun changePassword(current: String, next: String) = api.changePassword(current, next)

    // --- Key steps (AC-5 setup on Web only; Android sets up, pairs or recovers) ---

    /** First device of an account (key_version 0): creates ADK v1 and returns the phrase to show once. */
    suspend fun setUpKeys(): String {
        val s = _state.value
        val acct = requireNotNull(s.accountId)
        val prepared = keys.prepareSetup(acct)
        try {
            api.setupKeys(prepared.request)
        } catch (e: ApiException) {
            prepared.discard()
            throw e
        }
        prepared.commit(keys.store(acct))
        checkKeys()
        onAccountData.keysChanged()
        return prepared.phrase
    }

    suspend fun startPairing() = keys.startPairing()

    suspend fun pairingStatus(id: String): PairingStatus = api.pairingStatus(id)

    suspend fun finishPairing(start: AccountKeys.PairingStart, ready: PairingStatus): Int {
        val v = keys.finishPairing(requireNotNull(_state.value.accountId), start, ready)
        checkKeys()
        onAccountData.keysChanged()
        return v
    }

    suspend fun recover(phrase: String): Int {
        val v = keys.recover(requireNotNull(_state.value.accountId), phrase)
        checkKeys()
        onAccountData.keysChanged()
        return v
    }

    suspend fun lookupPairingCode(text: String) = keys.lookupCode(text)

    suspend fun sendKey(found: AccountKeys.CodeLookup) =
        keys.sendKeyTo(requireNotNull(_state.value.accountId), requireNotNull(_state.value.deviceId), found)

    suspend fun devices() = api.devices().devices

    suspend fun renameDevice(id: String, name: String) = api.renameDevice(id, name)

    /** DV-2 revoke: remembered before the request (fail closed), then a rotation that excludes it. */
    suspend fun revokeDevice(id: String) {
        val acct = requireNotNull(_state.value.accountId)
        val dev = requireNotNull(_state.value.deviceId)
        keys.rememberRevoked(acct, listOf(id))
        try {
            api.revokeDevice(id)
        } catch (e: ApiException) {
            keys.forgetRevoked(listOf(id))
            throw e
        }
        if (_state.value.keys == KeyStatus.Ready) {
            runCatching { keys.rotate(acct, dev, listOf(id)) }.onFailure { _state.update { s -> s.copy(rotationOwed = true) } }
        }
        checkKeys()
    }
}

/** What else holds account data on the device (history sync, Clipboard); wired by the app. */
open class AccountDataHooks {
    open suspend fun wipe() {}

    open suspend fun keysChanged() {}
}
