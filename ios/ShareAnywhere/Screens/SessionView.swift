import SATransferRuntime
import SwiftUI

/// The sender's live session: the share panel (TR-4), participants and requests (TR-5), and per-receiver progress
/// (TR-6) with the result (TR-7), as on Android's session and dashboard screens.
@MainActor
final class SessionModel: ObservableObject {
    let id: String
    @Published private(set) var view: SessionView?
    @Published private(set) var tx = TxState()
    @Published var error: String?
    @Published var busy: String?
    /// Server time minus device time, so the countdown follows the server's clock.
    private(set) var offset: TimeInterval = 0
    private var tasks: [Task<Void, Never>] = []
    private weak var app: AppModel?

    init(id: String) { self.id = id }

    func start(_ app: AppModel) {
        guard self.app == nil else { return }
        self.app = app
        let sender = app.hub.sender(id)
        let states = sender.state.values()
        tasks.append(Task { [weak self] in
            for await s in states {
                self?.tx = s
            }
        })
        let events = app.hub.socket.events()
        tasks.append(Task { [weak self] in
            for await e in events {
                guard let self else { return }
                await onEvent(e)
            }
        })
        Task { await reload() }
    }

    func stop() {
        for t in tasks {
            t.cancel()
        }
        tasks.removeAll()
    }

    func reload() async {
        guard let app else { return }
        do {
            let v = try await app.hub.services.get(id)
            apply(v)
            error = nil
        } catch {
            if view == nil { self.error = L10n.t("product.error_generic") }
        }
    }

    private func apply(_ v: SessionView) {
        view = v
        if let server = ISO8601.parse(v.serverTime) { offset = server.timeIntervalSinceNow }
    }

    private func onEvent(_ e: SocketEvent) async {
        guard e.sessionId == id || e.type == SocketEvent.open else { return }
        switch e.type {
        case "PARTICIPANT_JOINED":
            if let p = e.decode("participant", as: Participant.self) { announce(L10n.t("product.peer_joined", ["name": p.displayName])) }
            await reload()
        case "PARTICIPANT_REQUESTED":
            if let p = e.decode("participant", as: Participant.self) { announce(L10n.t("product.wants_to_join", ["name": p.displayName])) }
            await reload()
        case "SESSION_CLOSED", "SESSION_EXPIRED":
            await reload()
        default:
            if e.type.hasPrefix("PARTICIPANT_") || e.type == "SESSION_UPDATED" || e.type == SocketEvent.open || e.type == "PROTECTED_MODE" {
                await reload()
            }
        }
    }

    /// The join banner in the app, a local notification when the app is not in front.
    private func announce(_ text: String) {
        guard let app else { return }
        if app.hub.isForeground { app.toast = text } else { Notifications.post(
            id: "join-\(id)",
            title: text,
            body: L10n.t("product.notif_open_session")
        ) }
    }

    var now: Date { Date().addingTimeInterval(offset) }

    var windowOpen: Bool { view?.joinWindow?.state == "OPEN" }

    var ended: Bool {
        guard let s = view?.status else { return false }
        return s != "WAITING" && s != "ACTIVE"
    }

    func secondsLeft(at date: Date) -> Int {
        guard let ends = view?.joinWindow.flatMap({ ISO8601.parse($0.endsAt) }) else { return 0 }
        return Int(ends.timeIntervalSince(date.addingTimeInterval(offset)).rounded(.up))
    }

    // MARK: Actions

    func run(_ key: String, _ action: @escaping () async throws -> Void, failure: String = L10n.t("product.error_generic")) {
        busy = key
        Task {
            defer { busy = nil }
            do {
                try await action()
                await reload()
            } catch {
                app?.toast = failure
            }
        }
    }

    func renew() { run("renew") { [self] in try await apply(app!.hub.services.renew(id)) } }

    func stopAccepting() {
        run("stop") { [self] in try await apply(app!.hub.services.update(id, UpdateSessionRequest(acceptingReceivers: false))) }
    }

    func decide(_ p: Participant, _ d: Decision) {
        let failure = d == .block ? L10n.t("product.block_failed", ["name": p.displayName]) : L10n.t("product.error_generic")
        run(p.id, { [self] in _ = try await app!.hub.services.decide(participantId: p.id, d) }, failure: failure)
    }

    func remove(_ p: Participant) {
        run(p.id, { [self] in _ = try await app!.hub.services.remove(participantId: p.id) }, failure: L10n.t(
            "product.remove_failed",
            ["name": p.displayName]
        ))
    }

    func close() async -> Bool {
        guard let app else { return false }
        do {
            try await app.hub.services.close(id)
            app.hub.release(id)
            return true
        } catch {
            app.toast = L10n.t("product.close_failed")
            return false
        }
    }

    func pause(_ pid: String) { Task { await app?.hub.sender(id).pause(pid) } }
    func resume(_ pid: String) { Task { await app?.hub.sender(id).resume(pid) } }
    func stopAll() { Task { await app?.hub.sender(id).cancelAll() } }
}

enum ISO8601 {
    static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

struct SessionScreen: View {
    let id: String
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var keepAwake: KeepAwake
    @Environment(\.palette) private var p
    @StateObject private var s: SessionModel
    @State private var confirmClose = false
    @State private var confirmStopAll = false
    @State private var blockTarget: Participant?

    init(id: String) {
        self.id = id
        _s = StateObject(wrappedValue: SessionModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                if let v = s.view {
                    content(v)
                } else if let e = s.error {
                    Banner(kind: .danger, title: e, actionTitle: L10n.t("ios_yy.retry")) { Task { await s.reload() } }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(SATokens.Space.s8)
                }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.share_h"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !s.ended {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(L10n.t("ios.close")) { confirmClose = true }.accessibilityIdentifier("session.close")
                }
            }
        }
        .alert(L10n.t("product.close_h"), isPresented: $confirmClose) {
            Button(L10n.t("ios.close"), role: .destructive) {
                Task { if await s.close() { model.homePath.removeAll() } }
            }
            Button(L10n.t("ios.cancel"), role: .cancel) {}
        } message: { Text(L10n.t("product.close_p")) }
        .alert(L10n.t("product.stopall_h"), isPresented: $confirmStopAll) {
            Button(L10n.t("product.stop_all"), role: .destructive) { s.stopAll() }
            Button(L10n.t("ios.cancel"), role: .cancel) {}
        } message: { Text(L10n.t("product.stopall_p")) }
        .alert(
            L10n.t("product.block_confirm_named_h", ["name": blockTarget?.displayName ?? ""]),
            isPresented: Binding(get: { blockTarget != nil }, set: { if !$0 { blockTarget = nil } })
        ) {
            Button(L10n.t("product.block"), role: .destructive) { if let t = blockTarget { s.decide(t, .block) } }
            Button(L10n.t("ios.cancel"), role: .cancel) {}
        } message: { Text(L10n.t("product.block_confirm_p")) }
        .onAppear { s.start(model) }
        .onDisappear {
            s.stop()
            keepAwake.set("wait:\(id)", false)
        }
        .onChange(of: waiting) { keepAwake.set("wait:\(id)", $0) }
        .onAppear { keepAwake.set("wait:\(id)", waiting) }
        .screenID(screenID)
    }

    /// Waiting for receivers keeps the screen on (docs/ARCHITECTURE.md §7) while the code can still be used.
    private var waiting: Bool { !s.ended && s.windowOpen && s.view != nil }

    private var screenID: String {
        switch s.tx.final {
        case .completed: "dashboard-done"
        case .partial, .failed, .cancelled: "dashboard-partial"
        case nil: s.view != nil && !s.windowOpen && !s.ended ? "session-expired" : "session"
        }
    }

    @ViewBuilder private func content(_ v: SessionView) -> some View {
        if let final = s.tx.final { result(final) }
        if s.ended, s.tx.final == nil {
            Banner(kind: .info, title: L10n.t("product.session_closed")).accessibilityIdentifier("session.ended")
        }
        if !s.ended {
            share(v)
            if v.protectedMode { Banner(kind: .warning, title: L10n.t("product.protected_mode_sender")) }
            KeepOpenBanner(paused: s.tx.receivers.contains { $0.status == .paused } && !s.tx.isActive, context: id)
            if let cloud = s.tx.cloud, s.tx.final == nil { CloudUploadCard(state: cloud) }
        }
        if s.tx.loaded, !s.tx.hasFiles, !s.tx.files.isEmpty {
            Banner(kind: .danger, title: L10n.t("product.tx_err_files_gone_app")).accessibilityIdentifier("session.files-gone")
        }
        participants(v)
    }

    // MARK: Share panel (TR-4)

    @ViewBuilder private func share(_ v: SessionView) -> some View {
        let full = v.joinWindow?.state == "ENDED_FULL"
        if s.windowOpen, let code = v.code {
            Card {
                if let url = v.joinUrl {
                    QRCodeView(text: url)
                        .frame(maxWidth: 240)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel(L10n.t("product.qr_aria"))
                        .accessibilityIdentifier("session.qr")
                }
                Text(L10n.t("ios.code")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                Text(TransferText.code(code))
                    .typeStyle(SATokens.TypeScale.display)
                    .foregroundStyle(p.fg)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(L10n.t("product.code_aria", ["code": code.map(String.init).joined(separator: " ")]))
                    .accessibilityIdentifier("session-code")
                    .accessibilityValue(code)
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let left = s.secondsLeft(at: ctx.date)
                    Text(L10n.t("product.code_expires_in", ["time": TransferText.clock(left)]))
                        .typeStyle(SATokens.TypeScale.labelLg)
                        .foregroundStyle(left < 60 ? p.warningInk : p.fg2)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("session.countdown")
                        .task(id: left <= 0) { if left <= 0 { await s.reload() } }
                }
                HStack(spacing: SATokens.Space.s3) {
                    SecondaryButton(title: L10n.t("product.copy_code")) {
                        model.pasteboard.write(code)
                        model.toast = L10n.t("common.n_copied")
                    }
                    .accessibilityIdentifier("session.copy")
                    if let url = v.joinUrl.flatMap(URL.init(string:)) {
                        ShareLink(item: url) {
                            Text(L10n.t("ios.share")).typeStyle(SATokens.TypeScale.labelLg)
                                .frame(maxWidth: .infinity, minHeight: SATokens.Control.md)
                        }
                        .accessibilityIdentifier("session.share")
                    }
                }
                Text(L10n.t("common.cx_valid")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            }
        } else {
            Card {
                Text(L10n.t(full ? "product.session_full_s" : "ios_yy.cx_h"))
                    .typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
                    .accessibilityIdentifier("session.window-closed")
                Text(L10n.t("ios_yy.cx_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                PrimaryButton(title: L10n.t("ios_yy.cx_btn"), enabled: !full && s.busy == nil) { s.renew() }
                    .accessibilityIdentifier("session.renew")
            }
        }
        capacity(v)
    }

    @ViewBuilder private func capacity(_ v: SessionView) -> some View {
        if let c = v.capacity {
            HStack {
                Text(c.joined >= c.max ? L10n.t("product.capacity_full") : L10n.t(
                    "product.capacity",
                    ["joined": "\(c.joined)", "left": "\(max(0, c.max - c.joined))"]
                ))
                .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                .accessibilityIdentifier("session.capacity")
                Spacer()
                if v.requireApproval { Chip(text: L10n.t("ios.reqappr")).accessibilityIdentifier("session.approval-on") }
            }
            if s.windowOpen, c.joined > 0 {
                Button(L10n.t("product.stop_accepting")) { s.stopAccepting() }
                    .frame(minHeight: SATokens.touchTarget)
                    .disabled(s.busy != nil)
                    .accessibilityHint(L10n.t("product.stop_nudge"))
                    .accessibilityIdentifier("session.stop-accepting")
            }
        }
    }

    // MARK: Participants and progress (TR-5, TR-6)

    @ViewBuilder private func participants(_ v: SessionView) -> some View {
        let list = (v.participants ?? []).filter { $0.role == "receiver" && $0.status != "LEFT" && $0.status != "REJECTED" }
        HStack {
            Text(L10n.t("ios.receivers")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
            Spacer()
            if s.tx.isActive {
                Button(L10n.t("product.stop_all")) { confirmStopAll = true }
                    .frame(minHeight: SATokens.touchTarget)
                    .accessibilityIdentifier("dashboard.stop-all")
            }
        }
        if s.tx.receivers.count > 0 {
            let total = s.tx.receivers.reduce(Int64(0)) { $0 + $1.total }
            let done = s.tx.receivers.reduce(Int64(0)) { $0 + $1.verified }
            VStack(alignment: .leading, spacing: SATokens.Space.s1) {
                Text(L10n.t("ios.overall")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                TransferBar(done: done, total: total)
                Text(TransferText.eta(SessionResult.groupEta(s.tx.receivers).flatMap { $0 < 0 ? nil : $0 }))
                    .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("dashboard")
        }
        if list.isEmpty {
            Text(L10n.t(v.requireApproval ? "product.empty_receivers_appr" : "product.empty_receivers"))
                .typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                .accessibilityIdentifier("session.empty")
            if s.windowOpen { Text(L10n.t("ios.waiting_r")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2) }
        }
        ForEach(list, id: \.id) { participant in
            ParticipantCard(
                participant: participant,
                tx: s.tx.receivers.first { $0.participantId == participant.id },
                busy: s.busy == participant.id,
                ended: s.ended,
                onApprove: { s.decide(participant, .approve) },
                onReject: { s.decide(participant, .reject) },
                onRemove: { s.remove(participant) },
                onBlock: { blockTarget = participant },
                onPause: { s.pause(participant.id) },
                onResume: { s.resume(participant.id) }
            )
        }
    }

    @ViewBuilder private func result(_ final: TxFinal) -> some View {
        let (h, body, kind): (String, String, Banner.Kind) = switch final {
        case .completed: ("product.fin_completed_h", "product.fin_completed_p", .info)
        case .partial: ("product.fin_partial_h", "product.fin_partial_p", .warning)
        case .failed: ("product.fin_failed_h", "product.fin_failed_p", .danger)
        case .cancelled: ("product.fin_cancelled_h", "product.fin_cancelled_p", .warning)
        }
        Banner(kind: kind, title: L10n.t(h), message: L10n.t(body)).accessibilityIdentifier("dashboard.result")
        if s.ended {
            PrimaryButton(title: L10n.t("product.new_session")) {
                model.homePath.removeAll()
                model.homePath.append(.send)
            }
            .accessibilityIdentifier("dashboard.new-session")
        }
    }
}

/// One receiver (Participant card): name, badges, how it joined, security words, status and progress, and the
/// sender's actions (Approve / Reject for requests; Pause / Resume, Remove, Block for joined receivers).
struct ParticipantCard: View {
    let participant: Participant
    let tx: TxReceiver?
    let busy: Bool
    let ended: Bool
    let onApprove: () -> Void
    let onReject: () -> Void
    let onRemove: () -> Void
    let onBlock: () -> Void
    let onPause: () -> Void
    let onResume: () -> Void
    @Environment(\.palette) private var p

    var body: some View {
        Card {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(participant.displayName).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
                    Text(meta).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                }
                Spacer()
                Chip(text: chip, color: chipColor).accessibilityIdentifier("participant.status")
            }
            SecurityWords(caption: L10n.t("ios_xx.secw_s"), words: participant.securityWords ?? [])
            if let tx, participant.status == "JOINED" || tx.verified > 0 {
                TransferBar(done: tx.verified, total: tx.total, tint: tx.status == .completed ? p.receive : nil)
                HStack {
                    Text("\(formatBytes(tx.verified)) / \(formatBytes(tx.total))")
                    Spacer()
                    if tx.status.isActive, tx.bytesPerSecond > 0 { Text(TransferText.speed(tx.bytesPerSecond)) }
                    if let r = TransferText.route(tx.route) { Text(r) }
                }
                .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                if let e = tx.error { Text(L10n.t(e)).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.dangerInk) }
            }
            actions
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("participant")
    }

    private var meta: String {
        var parts = [platformName(participant.platform), L10n.t(participant.signedIn ? "product.badge_signed_in" : "product.badge_guest")]
        if let via = participant.joinedVia { parts.append(L10n.t(via == "link" ? "product.via_link" : "product.via_code")) }
        return parts.joined(separator: " · ")
    }

    private var chip: String {
        switch participant.status {
        case "REQUESTED": return L10n.t("ios_lbl.pending")
        case "REMOVED": return L10n.t("ios_lbl.removed")
        case "BLOCKED": return L10n.t("phrases.blocked")
        default: return tx.map { TransferText.status($0.status) } ?? L10n.t("ios_lbl.approved")
        }
    }

    private var chipColor: Color? {
        switch tx?.status {
        case .completed: p.receiveInk
        case .failed, .blocked: p.dangerInk
        case .paused, .reconnecting, .offline: p.warningInk
        case .transferring, .verifying, .connecting: p.sendInk
        default: nil
        }
    }

    @ViewBuilder private var actions: some View {
        if !ended {
            if participant.status == "REQUESTED" {
                HStack(spacing: SATokens.Space.s3) {
                    PrimaryButton(title: L10n.t("ios.approve"), enabled: !busy, action: onApprove)
                        .accessibilityLabel(L10n.t("product.approve_named", ["name": participant.displayName]))
                        .accessibilityIdentifier("participant.approve")
                    SecondaryButton(title: L10n.t("ios.reject"), enabled: !busy, action: onReject)
                        .accessibilityLabel(L10n.t("product.reject_named", ["name": participant.displayName]))
                        .accessibilityIdentifier("participant.reject")
                }
            } else if participant.status == "JOINED" {
                HStack(spacing: SATokens.Space.s4) {
                    if let tx, tx.status.isActive {
                        Button(L10n.t("ios.pause"), action: onPause).accessibilityIdentifier("participant.pause")
                    } else if tx?.status == .paused {
                        Button(L10n.t("ios.resume"), action: onResume).accessibilityIdentifier("participant.resume")
                    }
                    Spacer()
                    Button(L10n.t("ios_yy.remove"), action: onRemove)
                        .frame(minWidth: SATokens.touchTarget, minHeight: SATokens.touchTarget)
                        .disabled(busy)
                        .accessibilityLabel(L10n.t("product.remove_confirm", ["name": participant.displayName]))
                        .accessibilityIdentifier("participant.remove")
                    Button(L10n.t("product.block"), role: .destructive, action: onBlock)
                        .frame(minWidth: SATokens.touchTarget, minHeight: SATokens.touchTarget)
                        .disabled(busy)
                        .accessibilityLabel(L10n.t("product.block_named", ["name": participant.displayName]))
                        .accessibilityIdentifier("participant.block")
                }
                .typeStyle(SATokens.TypeScale.labelLg)
                .frame(minHeight: SATokens.touchTarget)
            }
        }
    }
}
