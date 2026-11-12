import Foundation
import SAAPIClient
import SAStore
import SATransferRuntime
import SwiftUI

/// Places on the Transfer tab's navigation stack (docs/UX_SCREEN_MAP.md destinations).
enum Route: Hashable {
    case send
    case session(String)
    case receive
    case preview(String)
    case receiving(String)
}

/// The app's long-lived services and the state the screens observe (one instance, created at launch).
@MainActor
final class AppModel: ObservableObject {
    let config: AppConfig
    let settings: SettingsStore
    let api: APIClient
    let identity: IdentityManager
    let history: HistoryStore
    let keepAwake: KeepAwake
    let hub: TransferHub

    @Published private(set) var identityState = IdentityState()
    @Published private(set) var historyEntries: [HistoryEntry] = []
    @Published private(set) var historyLoaded = false
    @Published var historyError: String?
    /// One-time toast text (rename done, history cleared…).
    @Published var toast: String?
    /// Which tab is selected (TR-1 "See all" opens History).
    @Published var tab: Tab = .home
    /// The Transfer tab's navigation path.
    @Published var homePath: [Route] = []
    /// Join previews by session id, from a resolved code or link (RX-4).
    var previews: [String: JoinPreview] = [:]

    enum Tab: Hashable { case home, history, devices, settings }

    init(config: AppConfig = .load()) {
        self.config = config
        if config.resetState { AppModel.resetForFreshInstall() }
        settings = SettingsStore()
        // A release build without an HTTPS backend is a build error in practice; fall back to an unreachable HTTPS URL so the
        // app still opens and shows the offline state rather than crashing.
        let agent = "ShareAnywhere-iOS/\(config.version)"
        guard let client = (try? APIClient(baseURL: config.backendURL, requireHTTPS: config.requireHTTPS, userAgent: agent))
            ?? (try? APIClient(baseURL: URL(string: "https://invalid.invalid")!, requireHTTPS: true, userAgent: agent))
        else { preconditionFailure("an HTTPS base URL is always accepted") }
        api = client
        let relay = StateRelay()
        identity = IdentityManager(
            api: DeviceAPI(client: api),
            store: KeychainSecretStore(),
            platform: "ios",
            onState: { s in relay.send(s) }
        )
        guard let store = (try? HistoryStore(path: AppModel.databasePath())) ?? (try? HistoryStore(path: ":memory:")) else {
            preconditionFailure("SQLite could not open even an in-memory database")
        }
        history = store
        let keepAwake = KeepAwake()
        self.keepAwake = keepAwake
        hub = TransferHub(api: client, identity: identity, history: store, keepAwake: keepAwake, graceSeconds: config.backgroundGrace)
        keepAwake.setEnabled(settings.keepScreenOn)
        relay.model = self
        Task { await start() }
    }

    private func start() async {
        if config.seedHistory { await seedHistory() }
        try? await history.sweep(settings.retention)
        Task {
            for await list in await history.observe() {
                historyEntries = list
                historyLoaded = true
            }
        }
        await identity.bootstrap()
    }

    func retryIdentity() { Task { await identity.bootstrap() } }

    func dismissReplaced() { Task { await identity.dismissReplaced() } }

    func rename(_ name: String) async -> Bool {
        do {
            _ = try await identity.rename(name)
            toast = L10n.t("ios_yy.n_renamed")
            return true
        } catch {
            toast = L10n.t("product.error_generic")
            return false
        }
    }

    func resetIdentity() async {
        do { _ = try await identity.reset() } catch { toast = L10n.t("product.error_generic") }
    }

    func deleteHistory(_ id: String) async {
        do { try await history.remove(id) } catch { historyError = L10n.t("product.error_generic") }
    }

    func clearHistory() async {
        do {
            try await history.clear()
            toast = L10n.t("ios_yy.n_cleared")
        } catch {
            historyError = L10n.t("product.error_generic")
        }
    }

    func setRetention(_ r: Retention) {
        settings.retention = r
        Task { try? await history.sweep(r) }
    }

    fileprivate func apply(_ s: IdentityState) { identityState = s }

    static func databasePath() -> String {
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return dir.appendingPathComponent("history.sqlite").path
    }

    /// `-resetState` (UI tests): forget everything a fresh install would not have.
    static func resetForFreshInstall() {
        if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
        let base = databasePath()
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: base + suffix) }
        let support = URL(fileURLWithPath: base).deletingLastPathComponent()
        try? FileManager.default.removeItem(at: support.appendingPathComponent("transfers"))
        if let docs = try? FileManager.default.contentsOfDirectory(at: SaveFolders.documents, includingPropertiesForKeys: nil) {
            for f in docs {
                try? FileManager.default.removeItem(at: f)
            }
        }
        let semaphore = DispatchSemaphore(value: 0)
        Task.detached {
            try? await KeychainSecretStore().clear()
            semaphore.signal()
        }
        semaphore.wait()
    }

    /// `-seedHistory` (UI tests): a few local entries, as a finished transfer would write them.
    private func seedHistory() async {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let entries = [
            HistoryEntry(
                id: "rx:ui-1", direction: .received, title: "holiday-photos.zip", fileCount: 1, totalBytes: 2_400_000_000,
                peer: "Office PC", status: .completed, createdAt: now - 60000,
                files: [HistoryFile(name: "holiday-photos.zip", size: 2_400_000_000)]
            ),
            HistoryEntry(
                id: "tx:ui-2", direction: .sent, title: "report.pdf", fileCount: 1, totalBytes: 1_200_000, transferredBytes: 400_000,
                peer: "Pixel 8", status: .failed, createdAt: now - 3_600_000, files: [HistoryFile(name: "report.pdf", size: 1_200_000)]
            )
        ]
        for e in entries {
            try? await history.add(e)
        }
    }
}

/// Carries identity updates from the actor to the main actor.
final class StateRelay: @unchecked Sendable {
    weak var model: AppModel?
    func send(_ s: IdentityState) {
        Task { @MainActor [weak self] in self?.model?.apply(s) }
    }
}
