import CryptoKit
import SATransferRuntime
import SwiftUI

/// The receiver's session: waiting for approval (RX-5 `rx-wait`), where to save (RX-5b, part of `rx-preview` on
/// iOS), receiving (RX-6 `rx-progress`) and the result (RX-7 `rx-done`), including removed, blocked, declined and
/// ended outcomes.
@MainActor
final class ReceivingModel: ObservableObject {
    enum Outcome: Equatable { case declined, removed, blocked, left, closed }
    let id: String
    @Published private(set) var me: Participant?
    @Published private(set) var senderName = ""
    @Published private(set) var rx = RxState()
    @Published private(set) var outcome: Outcome?
    @Published var error: String?
    @Published var leaving = false
    private var tasks: [Task<Void, Never>] = []
    private weak var app: AppModel?
    private var started = false

    init(id: String) { self.id = id }

    func start(_ app: AppModel) {
        guard self.app == nil else { return }
        self.app = app
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
            me = v.me
            senderName = v.sender?.displayName ?? senderName
            switch v.me?.status {
            case "JOINED": startReceiver()
            case "REJECTED": outcome = .declined
            case "REMOVED": outcome = .removed
            case "BLOCKED": outcome = .blocked
            case "LEFT": outcome = .left
            default: break
            }
            if v.status == "CLOSED" || v.status == "EXPIRED", v.me?.status == "REQUESTED" { outcome = .closed }
            error = nil
        } catch {
            if me == nil { self.error = JoinErrors.message(error) }
        }
    }

    private func startReceiver() {
        guard !started, let app else { return }
        started = true
        let states = app.hub.receiver(id).state.values()
        tasks.append(Task { [weak self] in
            for await s in states {
                self?.rx = s
            }
        })
    }

    private func onEvent(_ e: SocketEvent) async {
        guard e.sessionId == id || e.type == SocketEvent.open else { return }
        let mine = e.decode("participant", as: Participant.self)?.id == me?.id
        switch e.type {
        case "PARTICIPANT_APPROVED" where mine: await reload()
        case "PARTICIPANT_REJECTED" where mine: outcome = .declined
        case "PARTICIPANT_REMOVED" where mine: outcome = .removed
        case "PARTICIPANT_BLOCKED" where mine: outcome = .blocked
        case "SESSION_CLOSED", "SESSION_EXPIRED": if !rx.phase.isFinal { outcome = .closed }
        case SocketEvent.open: await reload()
        default: break
        }
    }

    var receiver: ReceiverController? { started ? app?.hub.receiver(id) : nil }

    func choose(_ target: SaveTarget) { Task { await receiver?.choose(target) } }
    func pause() { Task { await receiver?.pause() } }
    func resume() { Task { await receiver?.resume() } }
    func retry() { Task { await receiver?.retry() } }
    func cancel() { Task { await receiver?.cancel() } }

    func leave() async -> Bool {
        guard let app, let me else { return false }
        leaving = true
        defer { leaving = false }
        do {
            _ = try await app.hub.services.decide(participantId: me.id, .leave)
            app.hub.release(id)
            return true
        } catch {
            app.toast = L10n.t("product.leave_failed")
            return false
        }
    }
}

struct ReceivingView: View {
    let id: String
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var keepAwake: KeepAwake
    @EnvironmentObject private var hub: TransferHub
    @Environment(\.palette) private var p
    @Environment(\.openURL) private var openURL
    @StateObject private var m: ReceivingModel
    @State private var pickingFolder = false
    @State private var confirmCancel = false
    @State private var target: SaveTarget = SaveFolders.documentsTarget()
    @State private var hashes = ""

    init(id: String) {
        self.id = id
        _m = StateObject(wrappedValue: ReceivingModel(id: id))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) { content }
                .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.receive"))
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $pickingFolder, allowedContentTypes: [.folder]) { result in
            if case let .success(url) = result, let t = SaveFolders.folderTarget(url) { target = t }
        }
        .alert(L10n.t("product.rx_cancel_h"), isPresented: $confirmCancel) {
            Button(L10n.t("ios.cancel"), role: .destructive) { m.cancel() }
            Button(L10n.t("product.rx_keep"), role: .cancel) {}
        } message: { Text(L10n.t("product.rx_cancel_p")) }
        .onAppear {
            m.start(model)
            keepAwake.set("wait:rx:\(id)", waiting)
        }
        .onDisappear {
            m.stop()
            keepAwake.set("wait:rx:\(id)", false)
        }
        .onChange(of: waiting) { keepAwake.set("wait:rx:\(id)", $0) }
        .task(id: m.rx.phase) { if m.rx.phase == .completed, model.config.uiTesting { hashes = await savedHashes() } }
        .overlay(alignment: .bottomLeading) {
            if model.config.uiTesting {
                VStack {
                    Text(hashes).font(.system(size: 1)).opacity(0.02).frame(width: 1, height: 1)
                        .accessibilityIdentifier("test.rx-sha256").accessibilityValue(hashes)
                    // Blocks that arrived although already verified (must stay 0 across a pause and resume).
                    Text("\(m.rx.duplicates)").font(.system(size: 1)).opacity(0.02).frame(width: 1, height: 1)
                        .accessibilityIdentifier("test.rx-duplicates").accessibilityValue("\(m.rx.duplicates)")
                    // The classified route of the current connection (direct, relay-udp, relay-tls, …), for forced relay.
                    Text(m.rx.routeKind?.rawValue ?? "").font(.system(size: 1)).opacity(0.02).frame(width: 1, height: 1)
                        .accessibilityIdentifier("test.rx-route-kind").accessibilityValue(m.rx.routeKind?.rawValue ?? "none")
                }
            }
        }
        .screenID(screenID)
    }

    /// Waiting for the sender's approval keeps the screen on, like waiting for receivers.
    private var waiting: Bool { m.me?.status == "REQUESTED" && m.outcome == nil }

    private var screenID: String {
        if m.outcome != nil || m.rx.phase.isFinal { return "rx-done" }
        if m.me?.status == "REQUESTED" { return "rx-wait" }
        if m.rx.phase == .choose || m.rx.phase == .loading { return "rx-preview" }
        return "rx-progress"
    }

    @ViewBuilder private var content: some View {
        if let outcome = m.outcome, !m.rx.phase.isFinal {
            ended(outcome)
        } else if let me = m.me {
            if me.status == "REQUESTED" {
                waitingView(me)
            } else {
                switch m.rx.phase {
                case .loading: ProgressView().frame(maxWidth: .infinity).padding(SATokens.Space.s8)
                case .choose: saveStep
                case .completed, .partial, .failed, .cancelled: result
                default: progress
                }
            }
        } else if let e = m.error {
            Banner(kind: .danger, title: e, actionTitle: L10n.t("ios_yy.retry")) { Task { await m.reload() } }
        } else {
            ProgressView().frame(maxWidth: .infinity).padding(SATokens.Space.s8)
        }
    }

    // MARK: RX-5 waiting for approval

    @ViewBuilder private func waitingView(_ me: Participant) -> some View {
        Card {
            HStack(spacing: SATokens.Space.s3) {
                ProgressView()
                Text(L10n.t("ios.waiting")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
            }
            Text(L10n.t("product.waiting_body_app", ["name": m.senderName, "device": me.displayName]))
                .typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
            SecurityWords(caption: L10n.t("ios_xx.secw_r"), words: me.securityWords ?? [])
        }
        KeepOpenBanner(context: id)
        SecondaryButton(title: L10n.t("product.leave"), enabled: !m.leaving) {
            Task { if await m.leave() { model.homePath.removeAll() } }
        }
        .accessibilityIdentifier("rx.leave")
    }

    // MARK: RX-5b where to save

    @ViewBuilder private var saveStep: some View {
        Text(L10n.t("product.joined_session", ["name": m.senderName])).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
        SecurityWords(caption: L10n.t("ios_xx.secw_r"), words: m.rx.words)
        Card {
            Text(L10n.t("product.rx_save_h")).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
            saveOption(
                title: L10n.t("product.rx_documents_h"), detail: L10n.t("product.rx_documents_p"),
                selected: target.kind == .documents, id: "rx.save-documents"
            ) { target = SaveFolders.documentsTarget() }
            saveOption(
                title: target.kind == .folder ? target.label : L10n.t("product.rx_choose_folder"),
                detail: L10n.t("product.rx_folder_hint_ios"), selected: target.kind == .folder, id: "rx.save-folder"
            ) { pickingFolder = true }
            Text(L10n.t("product.rx_save_note")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg3)
        }
        if let e = m.rx.error { Banner(kind: .danger, title: L10n.t(e)) }
        fileList
        PrimaryButton(title: L10n.t("ios.startrx"), tone: .receive) { m.choose(target) }
            .accessibilityIdentifier("rx.start")
    }

    private func saveOption(title: String, detail: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: SATokens.Space.s3) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle").foregroundStyle(selected ? p.receive : p.fg3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg)
                    Text(detail).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                }
                Spacer()
            }
            .frame(minHeight: SATokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    // MARK: RX-6 receiving

    @ViewBuilder private var progress: some View {
        let suspended = hub.isSuspended("rx:\(id)")
        let rx = m.rx
        Card {
            HStack {
                Text(L10n.t("ios.receiving")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
                Spacer()
                Chip(text: TransferText.phase(rx.phase, suspended: suspended)).accessibilityIdentifier("rx.status")
            }
            TransferBar(done: rx.verified, total: rx.total, tint: p.receive)
            HStack {
                Text("\(formatBytes(rx.verified)) / \(formatBytes(rx.total))")
                Spacer()
                if rx.phase == .transferring, rx.bytesPerSecond > 0 { Text(TransferText.speed(rx.bytesPerSecond)) }
                if let r = TransferText.route(rx.route) { Text(r) }
            }
            .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            if rx.phase == .transferring { Text(TransferText.eta(rx.eta)).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2) }
            if let target = rx.target {
                Text(L10n.t("product.rx_saved_to", ["folder": target.label])).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg3)
            }
        }
        if rx.phase == .reconnecting { Banner(kind: .warning, title: L10n.t("product.rx_reconnecting")) }
        if rx.relayCapped {
            Banner(kind: .warning, title: L10n.t("product.relay_cap_reached")).accessibilityIdentifier("rx.relay-cap")
        }
        if rx.phase == .unreachable {
            Banner(kind: .danger, title: L10n.t("product.tx_err_unreachable"), actionTitle: L10n.t("ios_yy.retry")) { m.retry() }
        }
        if suspended { Banner(kind: .warning, title: L10n.t("ios.susp_h"), message: L10n.t("product.ios_susp_p")) }
        KeepOpenBanner(paused: rx.phase == .paused, context: id)
        fileList
        HStack(spacing: SATokens.Space.s3) {
            if rx.phase == .paused {
                PrimaryButton(title: L10n.t("ios.resume"), tone: .receive) { m.resume() }.accessibilityIdentifier("rx.resume")
            } else if rx.phase.isActive, rx.phase != .verifying {
                SecondaryButton(title: L10n.t("ios.pause")) { m.pause() }.accessibilityIdentifier("rx.pause")
            }
            SecondaryButton(title: L10n.t("ios.cancel")) { confirmCancel = true }.accessibilityIdentifier("rx.cancel")
        }
    }

    @ViewBuilder private var fileList: some View {
        Card {
            ForEach(m.rx.files) { f in
                VStack(alignment: .leading, spacing: SATokens.Space.s1) {
                    HStack {
                        Image(systemName: f.done ? "checkmark.seal.fill" : f.failed ? "xmark.octagon" : "doc")
                            .foregroundStyle(f.done ? p.receive : f.failed ? p.danger : p.fg2)
                            .accessibilityHidden(true)
                        Text(f.name).typeStyle(SATokens.TypeScale.body).lineLimit(2)
                        Spacer()
                        Text(formatBytes(f.size)).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    }
                    if !f.done, !f.failed, m.rx.phase != .choose { TransferBar(done: f.verified, total: f.size, tint: p.receive) }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("rx.file")
            }
        }
    }

    // MARK: RX-7 result

    @ViewBuilder private var result: some View {
        let rx = m.rx
        let done = rx.files.filter(\.done)
        let (title, kind): (String, Banner.Kind) = switch rx.phase {
        case .completed: (L10n.t("ios.done_h"), .info)
        case .partial: (L10n.t("product.rx_partial_h", ["done": "\(done.count)", "count": "\(rx.files.count)"]), .warning)
        case .cancelled: (L10n.t("product.rx_cancelled_h"), .warning)
        default: (L10n.t("product.rx_failed_h"), .danger)
        }
        let detail: String? = switch rx.phase {
        case .completed: L10n.t("product.rx_verified", ["count": TransferText.files(done.count), "size": formatBytes(rx.total)])
        case .partial: L10n.t("product.rx_partial_p")
        case .failed: rx.error.map { L10n.t($0) }
        default: nil
        }
        Banner(kind: kind, title: title, message: detail).accessibilityIdentifier("rx.result")
        if let outcome = m.outcome { Text(outcomeText(outcome)).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2) }
        if !done.isEmpty {
            Card {
                ForEach(done) { f in
                    HStack {
                        Text(f.name).typeStyle(SATokens.TypeScale.body).lineLimit(2)
                        Spacer()
                        if let url = f.savedURL {
                            if let link = SaveFolders.filesLink(url) {
                                Button(L10n.t("product.rx_open_in_files")) { openURL(link) }
                                    .accessibilityLabel(L10n.t("product.rx_open_file_named", ["name": f.name]))
                                    .accessibilityIdentifier("rx.open")
                            }
                            ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                                .accessibilityLabel(L10n.t("product.rx_share_file_named", ["name": f.name]))
                        }
                    }
                    .frame(minHeight: SATokens.touchTarget)
                }
                if let target = rx.target {
                    Text(L10n.t("product.rx_saved_to", ["folder": target.label])).typeStyle(SATokens.TypeScale.caption)
                        .foregroundStyle(p.fg3)
                }
            }
        }
        PrimaryButton(title: L10n.t("ios_yy.done")) { model.homePath.removeAll() }.accessibilityIdentifier("rx.done")
    }

    @ViewBuilder private func ended(_ outcome: ReceivingModel.Outcome) -> some View {
        Banner(
            kind: outcome == .declined ? .warning : .info,
            title: outcome == .declined ? L10n.t("product.declined_h") : outcomeText(outcome),
            message: outcome == .declined ? L10n.t("product.declined_p") : nil
        )
        .accessibilityIdentifier("rx.outcome")
        PrimaryButton(title: L10n.t("product.another_code"), tone: .receive) {
            model.homePath.removeAll()
            model.homePath.append(.receive)
        }
        SecondaryButton(title: L10n.t("ios_yy.done")) { model.homePath.removeAll() }
    }

    private func outcomeText(_ o: ReceivingModel.Outcome) -> String {
        switch o {
        case .declined: L10n.t("product.declined_p")
        case .removed: L10n.t("product.removed_rx")
        case .blocked: L10n.t("product.blocked_rx")
        case .left: L10n.t("product.left_rx")
        case .closed: L10n.t("product.closed_rx")
        }
    }

    /// `-uiTesting`: "name=sha256" per saved file, computed from what is on disk.
    private func savedHashes() async -> String {
        let files = m.rx.files.compactMap { f in f.savedURL.map { (f.name, $0) } }
        return await Task.detached {
            files.map { name, url in
                guard let data = try? Data(contentsOf: url) else { return "\(name)=missing" }
                return "\(name)=" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            }
            .joined(separator: ";")
        }.value
    }
}
