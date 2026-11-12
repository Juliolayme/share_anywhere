import Foundation
import SAAccount
import SAStore
import SATransferRuntime
import SwiftUI
import UIKit

/// The account side of the app (milestone 7.4): the account manager, the Clipboard Sync engine while this device is
/// added and holds the key, and live account events from the shared WebSocket. File sharing never depends on it
/// (PRD §2): a guest has no account state and the transfer screens never ask for one.
@MainActor
final class AccountSession: ObservableObject {
    @Published private(set) var state = AccountState()
    @Published private(set) var clip = ClipboardSnapshot()
    /// The account's devices (Devices tab), loaded on demand and after device events.
    @Published private(set) var devices: [AccountDevice] = []
    @Published private(set) var devicesError = false
    let manager: AccountManager
    let api: LiveAccountAPI
    private let clipStore: ClipboardStore
    private let socket: SessionSocket
    private var engine: ClipboardEngine?
    private var engineTask: Task<Void, Never>?
    private var snapshotTask: Task<Void, Never>?
    private var tasks: [Task<Void, Never>] = []
    private weak var app: AppModel?

    init(client: APIClient, identity: IdentityManager, history: HistoryStore, socket: SessionSocket) {
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        var account = dir.appendingPathComponent("account", isDirectory: true)
        // The sealed key vault and clipboard cache cannot be opened on another device: keep them out of backups.
        try? FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        var noBackup = URLResourceValues()
        noBackup.isExcludedFromBackup = true
        try? account.setResourceValues(noBackup)
        let api = LiveAccountAPI(client: client, identity: identity)
        self.api = api
        self.socket = socket
        let store = ClipboardStore(url: account.appendingPathComponent("clipboard.json"))
        clipStore = store
        let keys = AccountKeys(
            api: api, vault: AccountKeyVault(url: account.appendingPathComponent("keys.json"), sealer: KeychainSealer()),
            meta: SyncMeta(url: account.appendingPathComponent("meta.json"))
        )
        let relay = SessionRelay()
        manager = AccountManager(
            identity: identity, api: api, keys: keys, history: history,
            historyMeta: HistoryMetaStore(url: account.appendingPathComponent("history-sync.json")),
            hooks: AccountDataHooks(
                wipe: { await relay.session?.wipeClipboard() },
                keysChanged: { await relay.session?.keysChanged() }
            ),
            foreground: { await MainActor.run { UIApplication.shared.applicationState == .active } }
        )
        relay.session = self
        let states = manager.state.values()
        tasks.append(Task { [weak self] in
            for await s in states {
                self?.apply(s)
            }
        })
        let events = socket.events()
        tasks.append(Task { [weak self] in
            for await e in events {
                await self?.onEvent(e)
            }
        })
    }

    func attach(_ app: AppModel) {
        self.app = app
        app.pasteboard.onReturn = { [weak self] in await self?.captureOnReturn() }
    }

    /// Foreground capture: the pasteboard changed while the app was away. Likely secrets (`detectPatterns`, no read)
    /// are left for the user to paste on purpose; otherwise the text is read, which iOS confirms with its paste prompt.
    private func captureOnReturn() async {
        guard let engine, let pasteboard = app?.pasteboard, clip.settings?.paused != true else { return }
        if clip.settings?.sensitiveSkip ?? true, await pasteboard.probableSecret() { return }
        guard let text = pasteboard.readString() else { return }
        let r = await engine.capture(text, source: .auto)
        pasteboard.synced()
        if case .synced = r { app?.toast = L10n.t("product.cb_synced") }
    }

    func identityChanged(_ claims: TokenClaims?) { Task { await manager.identityChanged(claims) } }

    private func apply(_ s: AccountState) {
        let changedDevice = s.deviceId != state.deviceId || s.accountId != state.accountId
        state = s
        let wantsEngine = s.signedIn && s.added && s.keys == .ready && s.accountId != nil && s.deviceId != nil
        if wantsEngine, engine == nil || changedDevice { startEngine(account: s.accountId!, device: s.deviceId!) }
        if !wantsEngine, engine != nil || engineTask != nil, s.keys != .checking { stopEngine() }
    }

    private func startEngine(account: String, device: String) {
        stopEngine()
        app?.pasteboard.observe(true)
        let manager = manager
        let api = api
        let store = clipStore
        engineTask = Task { [weak self] in
            guard let keys = await manager.keyStore() else { return }
            let e = ClipboardEngine(
                api: api, keys: .of(keys), store: store, userId: account, deviceId: device,
                onKeyConflict: { _ = await manager.checkKeys() }
            )
            guard let self, !Task.isCancelled else { return }
            engine = e
            let snaps = e.state.values()
            snapshotTask = Task { [weak self] in
                for await s in snaps {
                    guard !Task.isCancelled else { return }
                    self?.clip = s
                }
            }
            await e.start()
        }
    }

    private func stopEngine() {
        app?.pasteboard.observe(false)
        engineTask?.cancel()
        engineTask = nil
        snapshotTask?.cancel()
        snapshotTask = nil
        if let e = engine { Task { await e.stop() } }
        engine = nil
        clip = ClipboardSnapshot()
    }

    fileprivate func wipeClipboard() async {
        stopEngine()
        await clipStore.wipe()
    }

    fileprivate func keysChanged() async { await engine?.keysChanged() }

    private func onEvent(_ e: SocketEvent) async {
        switch e.type {
        case "CLIPBOARD_EVENT_CREATED", "CLIPBOARD_EVENT_DELETED", "CLIPBOARD_HISTORY_CLEARED":
            await engine?.refresh()
        case "CLIPBOARD_SETTINGS_UPDATED":
            if let p = e.body["paused"], let r = e.body["retention_days"], let k = e.body["sensitive_skip"],
               case let .bool(paused) = p, case let .number(days) = r, case let .bool(skip) = k {
                await engine?.applySettings(ClipboardSettings(paused: paused, retentionDays: Int(days), sensitiveSkip: skip))
            }
        case "DEVICE_CONNECTED", "DEVICE_DISCONNECTED":
            if state.added { await loadDevices() }
        case SocketEvent.open:
            await engine?.refresh()
        default:
            break
        }
    }

    // MARK: Actions for the screens

    var signedIn: Bool { state.signedIn }

    func loadDevices() async {
        do {
            devices = try await manager.devices()
            devicesError = false
        } catch {
            devicesError = true
        }
    }

    func capture(_ text: String, force: Bool = false, flagged: Bool = false) async -> CaptureResult {
        guard let engine else { return .notReady }
        return await engine.capture(text, source: .manual, force: force, flagged: flagged)
    }

    func remove(_ id: String) async throws { try await engine?.remove(id) }
    func clearClipboard() async throws { try await engine?.clear() }
    func markCopied(_ id: String) async { await engine?.markCopied(id) }
    func noteClipboardText(_ text: String) async { await engine?.noteClipboardText(text) }
    func dismissSkipped(_ id: String) async { await engine?.dismissSkipped(id) }
    func refreshClipboard() async { await engine?.refresh() }

    func saveClipboardSettings(_ s: ClipboardSettings) async throws {
        guard let engine else { return }
        _ = try await engine.saveSettings(s)
    }
}

/// Lets account hooks reach the session created after them.
private final class SessionRelay: @unchecked Sendable {
    weak var session: AccountSession?
}

/// User-facing text for account API errors (sign in, sign up, reset, keys).
enum AccountErrors {
    static func message(_ error: any Error) -> String {
        if error is NetworkError { return L10n.t("product.acct_offline") }
        if let c = error as? CryptoError {
            switch c.code {
            case "recovery_unverified", "decrypt_failed", "invalid_phrase": return L10n.t("product.phrase_wrong")
            case "keys_legacy": return L10n.t("product.keys_legacy")
            case "untrusted_sender", "unverified": return L10n.t("product.key_change_unverified")
            default: return L10n.t("product.error_generic")
            }
        }
        guard let e = error as? APIError else { return L10n.t("product.error_generic") }
        switch e.code {
        case "invalid_credentials": return L10n.t("product.acct_invalid_credentials")
        case "email_taken": return L10n.t("product.acct_email_taken")
        case "weak_password": return L10n.t("product.acct_weak_password")
        case "already_signed_in": return L10n.t("product.acct_already_signed_in_device")
        case "keys_exist": return L10n.t("product.key_exists")
        case "invalid_email": return L10n.t("product.email_invalid")
        case "pairing_expired": return L10n.t("product.pair_expired")
        case "not_found": return L10n.t("product.pair_not_found")
        default: return e.status == 429 ? L10n.t("product.acct_rate_limited") : L10n.t("product.error_generic")
        }
    }
}
