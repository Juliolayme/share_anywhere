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
    let keepAwake: KeepAwake
    private let history: HistoryStore
    private let peers: any PeerFactory
    private let graceSeconds: Double
    private var senders: [String: SenderController] = [:]
    private var receivers: [String: ReceiverController] = [:]
    private var watchers: [String: Task<Void, Never>] = [:]
    /// Sessions paused because the app left the screen; resumed when it is active again.
    @Published private(set) var suspended: Set<String> = []
    /// Sessions with bytes moving now (Transfer home's active card).
    @Published private(set) var active: [String: Bool] = [:]
    private(set) var isForeground = true
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var graceTask: Task<Void, Never>?

    init(api: APIClient, identity: IdentityManager, history: HistoryStore, keepAwake: KeepAwake, graceSeconds: Double) {
        let services = LiveServices(client: api, identity: identity)
        self.services = services
        self.history = history
        self.keepAwake = keepAwake
        self.graceSeconds = graceSeconds
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
    }

    // MARK: Controllers

    func sender(_ id: String) -> SenderController {
        if let s = senders[id] { return s }
        let c = SenderController(SenderDeps(
            sessionId: id, sessions: services, transfers: services, socket: socket, peers: peers, outgoing: outgoing, history: history,
            openSource: { ScopedFileSource($0) }
        ))
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
        let c = ReceiverController(ReceiverDeps(
            sessionId: id, sessions: services, transfers: services, socket: socket, peers: peers, targets: targets, saved: saved,
            history: history, resolveFolder: { SaveFolders.resolve($0) }
        ))
        receivers[id] = c
        Task { await c.start() }
        let states = c.state.values()
        watch("rx:\(id)") { mark in
            for await s in states {
                await mark(s.phase.isActive)
            }
        }
        return c
    }

    /// Ends a session's controllers (session closed and left, or a new identity).
    func release(_ id: String) {
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
    func createSession(files: [PickedFile], requireApproval: Bool) async throws -> SessionView {
        let view = try await services.create(
            files: files.map { FileInput(name: $0.name, size: $0.size, mime: $0.mime) }, requireApproval: requireApproval
        )
        let shared = view.files ?? []
        let rows = zip(shared, files).map { OutgoingFile(fileId: $0.id, size: $0.size, locator: $1.bookmark) }
        try await outgoing.put(view.id, rows)
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
            Task { @MainActor in
                await self?.suspendAll()
                self?.endBackgroundTask()
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
    private func suspendAll() async {
        graceTask = nil
        guard !isForeground else { return }
        var any = false
        for (id, c) in senders where c.state.value.isActive {
            suspended.insert("tx:\(id)")
            await c.pauseAll()
            any = true
        }
        for (id, c) in receivers where c.state.value.phase.isActive {
            suspended.insert("rx:\(id)")
            await c.pause()
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
                Task {
                    for r in c.state.value.receivers where r.status == .paused {
                        await c.resume(r.participantId)
                    }
                }
            } else if key.hasPrefix("rx:"), let c = receivers[id] {
                Task { await c.resume() }
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
