import Foundation
import SAStore
import SATransferRuntime
import SwiftUI
import UIKit
import UserNotifications

/// The live transfer side of the app: one WebSocket, the per-session sender and receiver controllers, the records they
/// keep (outgoing bookmarks, save targets, saved files), keep-screen-on reasons from transfers, and the iOS lifecycle
/// policy (docs/ADR/0027-ios-background-policy.md): leaving the screen pauses transfers after a short background-task
/// grace period and posts `ios.susp_h`; coming back resumes them.
@MainActor
final class TransferHub: ObservableObject {
    let services: LiveServices
    let socket: SessionSocket
    let outgoing: JSONMap<[OutgoingFile]>
    let targets: JSONMap<SaveTarget>
    let saved: JSONMap<String>
    /// Receives running (or paused by the background policy) when the process ended: resumed on the next launch.
    let pending: JSONMap<PendingReceive>
    let keepAwake: KeepAwake
    private let history: HistoryStore
    private let peers: any PeerFactory
    private let graceSeconds: Double
    /// The ICE policy step receivers start on (`all`; UI tests force a relay step).
    private let routeStep: PolicyStep
    private var senders: [String: SenderController] = [:]
    private var receivers: [String: ReceiverController] = [:]
    private var watchers: [String: Task<Void, Never>] = [:]
    /// Sessions paused because the app left the screen; resumed when it is active again.
    @Published private(set) var suspended: Set<String> = []
    /// Receivers of a sending session that the background policy paused (only these resume on return).
    private var suspendedReceivers: [String: [String]] = [:]
    /// Sessions with bytes moving now (Transfer home's active card).
    @Published private(set) var active: [String: Bool] = [:]
    private(set) var isForeground = true
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var graceTask: Task<Void, Never>?

    init(
        api: APIClient, identity: IdentityManager, history: HistoryStore, keepAwake: KeepAwake, graceSeconds: Double,
        routeStep: PolicyStep = .all, insecureTurnTLS: Bool = false
    ) {
        let services = LiveServices(client: api, identity: identity)
        self.services = services
        self.history = history
        self.keepAwake = keepAwake
        self.graceSeconds = graceSeconds
        self.routeStep = routeStep
        WebRTCPeerFactory.shared.allowInsecureTurnTLS(insecureTurnTLS)
        peers = WebRTCPeerFactory.shared
        socket = SessionSocket(
            baseURL: api.baseURL,
            connector: URLSessionWebSocketConnector(),
            ticket: { try await services.wsTicket().ticket }
        )
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        outgoing = JSONMap(url: dir.appendingPathComponent("transfers/outgoing.json"))
        targets = JSONMap(url: dir.appendingPathComponent("transfers/targets.json"))
        saved = JSONMap(url: dir.appendingPathComponent("transfers/saved.json"))
        pending = JSONMap(url: dir.appendingPathComponent("transfers/pending-receives.json"))
    }

    // MARK: Controllers

    func sender(_ id: String) -> SenderController {
        if let s = senders[id] { return s }
        var deps = SenderDeps(
            sessionId: id, sessions: services, transfers: services, socket: socket, peers: peers, outgoing: outgoing, history: history,
            openSource: { ScopedFileSource($0) }
        )
        if cloudSessions.contains(id) { deps.cloud = services }
        let c = SenderController(deps)
        senders[id] = c
        Task { await c.start() }
        let states = c.state.values()
        watch("tx:\(id)") { mark in
            for await s in states {
                await mark(s.isActive)
            }
        }
        return c
    }

    func receiver(_ id: String) -> ReceiverController {
        if let r = receivers[id] { return r }
        var deps = ReceiverDeps(
            sessionId: id, sessions: services, transfers: services, socket: socket, peers: peers, targets: targets, saved: saved,
            history: history, resolveFolder: { SaveFolders.resolve($0) }
        )
        deps.routeStep = routeStep
        deps.cloud = services
        let c = ReceiverController(deps)
        receivers[id] = c
        Task { await c.start() }
        let states = c.state.values()
        let pending = pending
        watch("rx:\(id)") { mark in
            var last = RxPhase.loading
            for await s in states {
                await mark(s.phase.isActive)
                // Remembered while it runs, forgotten when it ends (a failure while loading, e.g. offline at launch, is
                // kept so the next launch tries again).
                if s.phase.isActive, await pending.get(id) == nil {
                    try? await pending.put(id, PendingReceive(since: Int64(Date().timeIntervalSince1970 * 1000), suspended: false))
                } else if s.phase.isFinal, !(s.phase == .failed && last == .loading) {
                    try? await pending.put(id, nil)
                }
                last = s.phase
            }
        }
        return c
    }

    /// The next launch after the process ended mid-receive (ADR 0027, Phase 9): recreates every receive that was
    /// running or paused by the background policy in the last day. Each reloads its session and resumes from its
    /// persisted bitmap; one the background policy paused is resumed once loaded, as a return to the app would.
    func resumeUnfinished() async {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        for (id, p) in await pending.all() {
            guard now - p.since < 24 * 3_600_000, receivers[id] == nil else {
                if now - p.since >= 24 * 3_600_000 { try? await pending.put(id, nil) }
                continue
            }
            let c = receiver(id)
            guard p.suspended else { continue }
            Task {
                for await s in c.state.values() where s.phase != .loading {
                    if s.phase == .paused { await c.resume() }
                    break
                }
                try? await pending.put(id, PendingReceive(since: p.since, suspended: false))
            }
        }
    }

    /// A new device identity (reset, or the server replaced a revoked one): receives recorded for the old device
    /// cannot be resumed by the new one, so they are forgotten.
    func forgetPending() async {
        for (id, _) in await pending.all() {
            try? await pending.put(id, nil)
        }
    }

    /// Ends a session's controllers (session closed and left, or a new identity).
    func release(_ id: String) {
        let pending = pending
        Task { try? await pending.put(id, nil) }
        for key in ["tx:\(id)", "rx:\(id)"] {
            watchers.removeValue(forKey: key)?.cancel()
            keepAwake.set(key, false)
            active[key] = nil
        }
        if let s = senders.removeValue(forKey: id) { Task { await s.dispose() } }
        if let r = receivers.removeValue(forKey: id) { Task { await r.dispose() } }
    }

    /// A transfer keeps the screen on while bytes move (connecting, transferring, reconnecting, verifying).
    private func watch(_ key: String, _ body: @escaping @Sendable (@escaping @Sendable (Bool) async -> Void) async -> Void) {
        watchers[key]?.cancel()
        watchers[key] = Task { [weak self] in
            await body { isActive in await self?.mark(key, isActive) }
        }
    }

    private func mark(_ key: String, _ isActive: Bool) {
        keepAwake.set(key, isActive)
        if active[key] != isActive { active[key] = isActive }
    }

    var anyActive: Bool { active.values.contains(true) }

    // MARK: Sending

    /// TR-3 → TR-4: creates the session and keeps the picked files' bookmarks for it.
    /// Sessions created with Cloud transfer chosen (after the consent sheet); their senders upload (§9).
    private var cloudSessions: Set<String> = []

    func createSession(files: [PickedFile], requireApproval: Bool, cloud: Bool = false) async throws -> SessionView {
        let view = try await services.create(
            files: files.map { FileInput(name: $0.name, size: $0.size, mime: $0.mime) }, requireApproval: requireApproval
        )
        let shared = view.files ?? []
        let rows = zip(shared, files).map { OutgoingFile(fileId: $0.id, size: $0.size, locator: $1.bookmark) }
        try await outgoing.put(view.id, rows)
        if cloud { cloudSessions.insert(view.id) }
        return view
    }

    // MARK: Lifecycle

    func scenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            isForeground = true
            keepAwake.setSceneActive(true)
            graceTask?.cancel()
            graceTask = nil
            endBackgroundTask()
            resumeSuspended()
        case .background:
            isForeground = false
            keepAwake.setSceneActive(false)
            enterBackground()
        default:
            break
        }
    }

    private func enterBackground() {
        guard anyActive, graceTask == nil else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "transfer-grace") { [weak self] in
            // iOS needs the task ended before this handler returns; the pause follows as far as time allows.
            MainActor.assumeIsolated {
                self?.graceTask?.cancel()
                self?.graceTask = nil
                self?.endBackgroundTask()
                Task { await self?.suspendAll(force: true) }
            }
        }
        let grace = graceSeconds
        graceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
            if Task.isCancelled { return }
            await self?.suspendAll()
            self?.endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    /// Pauses every active transfer (the bitmap is persisted with each verified block) and posts `ios.susp_h`.
    private func suspendAll(force: Bool = false) async {
        if !force { graceTask = nil }
        guard !isForeground else { return }
        var any = false
        for (id, c) in senders where c.state.value.isActive {
            // Cloud Distribution (PRD §2 iOS long transfers): with the files sealed in the cloud, receivers finish from
            // there once this suspended app drops off, so the transfer is not paused.
            if c.state.value.cloud?.ready == true { continue }
            suspended.insert("tx:\(id)")
            let active = c.state.value.receivers.filter(\.status.isActive).map(\.participantId)
            suspendedReceivers[id] = active
            for pid in active {
                await c.pause(pid)
            }
            any = true
        }
        for (id, c) in receivers where c.state.value.phase.isActive {
            suspended.insert("rx:\(id)")
            await c.pause()
            // If iOS ends the suspended app, the next launch resumes this receive (resumeUnfinished).
            let since = await pending.get(id)?.since ?? Int64(Date().timeIntervalSince1970 * 1000)
            try? await pending.put(id, PendingReceive(since: since, suspended: true))
            any = true
        }
        if any { Notifications.post(id: "suspended", title: L10n.t("ios.susp_h"), body: L10n.t("product.ios_susp_p")) }
    }

    private func resumeSuspended() {
        let keys = suspended
        suspended.removeAll()
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["suspended"])
        for key in keys {
            let id = String(key.dropFirst(3))
            if key.hasPrefix("tx:"), let c = senders[id] {
                let pids = suspendedReceivers.removeValue(forKey: id) ?? []
                Task {
                    for pid in pids {
                        await c.resume(pid)
                    }
                }
            } else if key.hasPrefix("rx:"), let c = receivers[id] {
                let pending = pending
                Task {
                    await c.resume()
                    if let p = await pending.get(id) { try? await pending.put(id, PendingReceive(since: p.since, suspended: false)) }
                }
            }
        }
    }

    func isSuspended(_ key: String) -> Bool { suspended.contains(key) }
}

/// Local notifications (receiver joined, transfer paused in the background). Nothing is posted without permission.
enum Notifications {
    static func post(id: String, title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        }
    }
}

/// A receive to resume on the next launch: when it started, and whether the background policy paused it.
struct PendingReceive: Codable, Sendable {
    var since: Int64
    var suspended: Bool
}
