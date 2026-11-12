import Foundation
import SAStore

/// The account on this device (docs/UX_SCREEN_MAP.md §7–§9, PRD §2 Signing in); guests have none.
public struct AccountState: Sendable, Equatable {
    public var signedIn = false
    public var accountId: String?
    public var email: String?
    /// Added to the account (`dl`): needed for keys, history sync and Clipboard Sync.
    public var added = false
    public var deviceId: String?
    public var keys: KeyStatus = .none
    public var keyVersion = 0
    /// A rotation the server says is owed could not be made yet (Devices shows it).
    public var rotationOwed = false
    public var historySync = false
    /// `GET /v1/me` failed (the account state on screen may be stale).
    public var meFailed = false
    public var sync = HistorySyncState()
    public init() {}
}

/// The last history sync pass (HI-1 banner: "Synced {when}", "Syncing…", error with Retry).
public struct HistorySyncState: Sendable, Equatable {
    public var running = false
    /// Epoch ms of the last successful pass.
    public var at: Int64?
    public var unreadable = 0
    public var error = false
    public var offline = false
    public init() {}
}

/// What else holds account data on the device (Clipboard Sync); wired by the app.
public struct AccountDataHooks: Sendable {
    public var wipe: @Sendable () async -> Void
    public var keysChanged: @Sendable () async -> Void
    public init(wipe: @escaping @Sendable () async -> Void = {}, keysChanged: @escaping @Sendable () async -> Void = {}) {
        self.wipe = wipe
        self.keysChanged = keysChanged
    }
}

/// Account sessions layered on the device identity (ADR 0002, ADR 0010), the Swift twin of Android's `AccountManager`:
/// sign-up and sign-in keep the same device, sign-out replaces it with a new anonymous one. Follows the token's `acct`
/// claim: when the account session ends without a sign-out here (revoked elsewhere, password reset, expiry), every
/// account key and account record on the device is erased. Runs key checks when signed in and added (on start, then
/// every 30 s while the app is in front).
public actor AccountManager {
    public nonisolated let state = ValueCell(AccountState())
    private let identity: IdentityManager
    private let api: any AccountEndpoints & HistoryEndpoints
    private let keys: AccountKeys
    private let history: HistoryStore
    private let historyMeta: HistoryMetaStore
    private let hooks: AccountDataHooks
    private let foreground: @Sendable () async -> Bool
    private let tickMs: Int64
    private var ticker: Task<Void, Never>?
    private var syncing: Task<Void, Never>?
    private var checking: Task<KeyStatus, Never>?
    private var lastClaims: TokenClaims?

    public init(
        identity: IdentityManager, api: any AccountEndpoints & HistoryEndpoints, keys: AccountKeys, history: HistoryStore,
        historyMeta: HistoryMetaStore, hooks: AccountDataHooks = AccountDataHooks(),
        foreground: @escaping @Sendable () async -> Bool = { true },
        tickMs: Int64 = 30000
    ) {
        self.identity = identity
        self.api = api
        self.keys = keys
        self.history = history
        self.historyMeta = historyMeta
        self.hooks = hooks
        self.foreground = foreground
        self.tickMs = tickMs
    }

    private var s: AccountState { state.value }
    private func update(_ f: (inout AccountState) -> Void) {
        var v = state.value
        f(&v)
        state.set(v)
    }

    /// The identity's claims changed (bootstrap, refresh, sign-in, Add this device, sign-out).
    public func identityChanged(_ c: TokenClaims?) async {
        if c?.acct == lastClaims?.acct, c?.dl == lastClaims?.dl, c?.sub == lastClaims?.sub, lastClaims != nil { return }
        lastClaims = c
        let prev = s
        if prev.signedIn, let old = prev.accountId, old != c?.acct {
            // The account session ended here or elsewhere: nothing of that account stays on the device.
            await wipeAccountData()
        }
        if let c, c.acct == nil, await keys.leftover() {
            // The account session ended while the app was not running (revoked elsewhere, reset, expiry).
            await wipeAccountData()
        }
        guard let c, let acct = c.acct else {
            var fresh = AccountState()
            fresh.deviceId = c?.sub
            state.set(fresh)
            await history.setSyncHandler(nil)
            ticker?.cancel()
            ticker = nil
            return
        }
        update {
            $0.signedIn = true
            $0.accountId = acct
            $0.added = c.dl
            $0.deviceId = c.sub
            if !c.dl { $0.keys = .none }
        }
        await refreshMe()
        if c.dl { startTicker() } else {
            ticker?.cancel()
            ticker = nil
        }
    }

    private func wipeAccountData() async {
        await history.setSyncHandler(nil)
        await keys.wipe()
        await historyMeta.wipe()
        await hooks.wipe()
    }

    private func startTicker() {
        if ticker != nil { return }
        let ms = tickMs
        ticker = Task {
            var first = true
            while !Task.isCancelled {
                let inFront = await self.foreground()
                if first || inFront {
                    let status = await self.checkKeys()
                    if status == .ready, first || self.state.value.historySync { await self.syncNow() }
                }
                first = false
                try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            }
        }
    }

    public func refreshMe() async {
        do {
            let me = try await api.me()
            update {
                $0.email = me.email
                $0.historySync = me.historySync
                $0.added = me.device.added
                $0.meFailed = false
            }
            await updateSyncHandler()
        } catch {
            update { $0.meFailed = true }
        }
    }

    public func keyStore() async -> (any KeyStore)? {
        guard let acct = s.accountId else { return nil }
        return await keys.store(acct)
    }

    // MARK: History sync

    private struct SyncHandler: HistorySyncHandler {
        let manager: AccountManager
        let account: String
        func removed(_ ids: [String]) async { await manager.reportSync { try await HistorySync.deleteSynced(
            manager.api,
            manager.historyMeta,
            userId: account,
            localIDs: ids
        ) } }
        func cleared() async { await manager.reportSync { try await HistorySync.clearSynced(
            manager.api,
            manager.historyMeta,
            userId: account
        ) } }
    }

    /// Local deletions tombstone the synced copies while history sync is on (queued when offline).
    private func updateSyncHandler() async {
        let st = s
        if let acct = st.accountId, st.added, st.historySync {
            await history.setSyncHandler(SyncHandler(manager: self, account: acct))
        } else {
            await history.setSyncHandler(nil)
        }
    }

    private func reportSync(_ body: () async throws -> Void) async {
        do { try await body() } catch {
            let offline = error is NetworkError
            update {
                $0.sync.error = true
                $0.sync.offline = offline
            }
        }
    }

    /// One history sync pass (a pending "copy history" import runs even with sync off). Concurrent calls share one pass.
    public func syncNow() async {
        let st = s
        guard let acct = st.accountId, let dev = st.deviceId, st.added, st.keys == .ready else { return }
        if let running = syncing {
            await running.value
            return
        }
        let task = Task {
            self.update { $0.sync.running = true }
            do {
                var names: [String: String] = [:]
                if st.historySync, let list = try? await self.api.devices() {
                    names = Dictionary(list.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
                }
                let res = try await HistorySync.sync(HistorySync.Deps(
                    api: self.api, keys: self.keys.store(acct), history: self.history, meta: self.historyMeta, userId: acct, deviceId: dev,
                    enabled: st.historySync, deviceNames: names, onKeyConflict: { _ = await self.checkKeys() }
                ))
                var sync = HistorySyncState()
                sync.at = Int64(Date().timeIntervalSince1970 * 1000)
                sync.unreadable = res.unreadable
                self.update { $0.sync = sync }
            } catch {
                let offline = error is NetworkError
                self.update {
                    $0.sync.running = false
                    $0.sync.error = true
                    $0.sync.offline = offline
                }
            }
        }
        syncing = task
        await task.value
        syncing = nil
    }

    /// A key check (pickup, re-proof, chain import, owed rotation); the state shows the result.
    @discardableResult
    public func checkKeys() async -> KeyStatus {
        if let running = checking { return await running.value }
        let task = Task { await self.checkOnce() }
        checking = task
        let status = await task.value
        checking = nil
        return status
    }

    private func checkOnce() async -> KeyStatus {
        let st = s
        guard let acct = st.accountId, let dev = st.deviceId, st.added else { return .none }
        if st.keys == .none { update { $0.keys = .checking } }
        do {
            let check = try await keys.check(account: acct, device: dev)
            update {
                $0.keys = check.status
                $0.keyVersion = check.keyVersion
                $0.rotationOwed = check.rotationOwed
            }
            if !check.newVersions.isEmpty {
                await hooks.keysChanged()
                if check.status == .ready { Task { await self.syncNow() } }
            }
            return check.status
        } catch {
            update { if $0.keys == .checking { $0.keys = .error } }
            return .error
        }
    }

    // MARK: Sign in and out

    public func signUp(email: String, password: String, addDevice: Bool) async throws {
        let r = try await api.signUp(email: email.trimmingCharacters(in: .whitespaces), password: password, addDevice: addDevice)
        await identity.adoptToken(r.accessToken, expiresIn: r.expiresIn)
        update { $0.email = r.account.email }
    }

    public func signIn(email: String, password: String, addDevice: Bool) async throws {
        let r = try await api.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password, addDevice: addDevice)
        await identity.adoptToken(r.accessToken, expiresIn: r.expiresIn)
        update { $0.email = r.account.email }
    }

    /// AC-4 "Add this device" after a short sign-in; returns the key state that decides the next screen.
    public func addThisDevice(copyHistory: Bool) async throws -> KeyStatus {
        let t = try await api.addCurrent(copyHistory: copyHistory)
        if let acct = s.accountId {
            var meta = await historyMeta.get(acct)
            meta.pushSince = Int64(Date().timeIntervalSince1970 * 1000)
            meta.importPending = copyHistory
            try? await historyMeta.put(meta)
        }
        await identity.adoptToken(t.accessToken, expiresIn: t.expiresIn)
        // The identity relay updates the state; wait for it, then check the key.
        for _ in 0 ..< 50 where !s.added {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return await checkKeys()
    }

    /// AC-7 sign-out: a new anonymous identity replaces this device; account keys and records are erased; local History
    /// stays unless `clearHistory` (PRD §2).
    public func signOut(clearHistory: Bool) async throws {
        let session = try await api.signOut()
        await wipeAccountData()
        if clearHistory { try? await history.clear(sync: false) }
        try await identity.replaceSession(session)
    }

    public func requestReset(email: String) async throws { try await api.requestReset(email: email.trimmingCharacters(in: .whitespaces)) }

    public func setHistorySync(_ on: Bool) async throws {
        let me = try await api.setHistorySync(on)
        update { $0.historySync = me.historySync }
        await updateSyncHandler()
        if me.historySync { Task { await self.syncNow() } }
    }

    // MARK: Key steps

    /// On the first device of an account (key_version 0): creates ADK v1 and the recovery phrase on the device only.
    /// Nothing reaches the server until `commitKeys` (after "I wrote down my recovery phrase").
    public func prepareKeys() async throws -> KeyFlows.PreparedSetup {
        guard let acct = s.accountId else { throw KeyStateError(status: .none) }
        return try await keys.prepareSetup(account: acct)
    }

    /// Sends the prepared setup (`POST /v1/keys/setup`) and only then stores the key. `409 keys_exist` means pair instead.
    public func commitKeys(_ prepared: KeyFlows.PreparedSetup) async throws {
        guard let acct = s.accountId else { throw KeyStateError(status: .none) }
        do {
            _ = try await api.setupKeys(prepared.request)
        } catch let e as APIError {
            // Another device created the key first: this one is never used. Other errors keep it for a retry.
            if e.code == "keys_exist" { prepared.discard() }
            throw e
        }
        try await prepared.commit(keys.store(acct))
        await checkKeys()
        await hooks.keysChanged()
    }

    public func startPairing() async throws -> AccountKeys.PairingStart { try await keys.startPairing() }

    public func pairingStatus(_ id: String) async throws -> PairingStatus { try await api.pairingStatus(id) }

    public func finishPairing(_ start: AccountKeys.PairingStart, ready: PairingStatus) async throws -> Int {
        guard let acct = s.accountId else { throw KeyStateError(status: .none) }
        let v = try await keys.finishPairing(account: acct, start: start, ready: ready)
        await checkKeys()
        await hooks.keysChanged()
        return v
    }

    public func recover(phrase: String) async throws -> Int {
        guard let acct = s.accountId else { throw KeyStateError(status: .none) }
        let v = try await keys.recover(account: acct, phrase: phrase)
        await checkKeys()
        await hooks.keysChanged()
        return v
    }

    public func lookupPairingCode(_ text: String) async throws -> AccountKeys.CodeLookup? { try await keys.lookupCode(text) }

    public func sendKey(to found: AccountKeys.CodeLookup) async throws {
        guard let acct = s.accountId, let dev = s.deviceId else { throw KeyStateError(status: .none) }
        try await keys.sendKey(account: acct, device: dev, to: found)
    }

    public func devices() async throws -> [AccountDevice] { try await api.devices() }

    public func renameDevice(_ id: String, name: String) async throws -> AccountDevice { try await api.renameDevice(id, name: name) }

    /// DV-2 revoke: remembered before the request (fail closed), then a rotation that excludes it.
    public func revokeDevice(_ id: String) async throws {
        guard let acct = s.accountId, let dev = s.deviceId else { throw KeyStateError(status: .none) }
        try await keys.rememberRevoked(account: acct, ids: [id])
        do {
            try await api.revokeDevice(id)
        } catch {
            try? await keys.forgetRevoked([id])
            throw error
        }
        if s.keys == .ready {
            do { _ = try await keys.rotate(account: acct, device: dev, exclude: [id]) } catch { update { $0.rotationOwed = true } }
        }
        await checkKeys()
    }
}
