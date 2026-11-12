import SAAccount
import SwiftUI
import UIKit

/// Every read of the system pasteboard goes through here, so a guest provably never touches it (the `-uiTesting` probe
/// shows the count, docs/phases/PHASE_7_IOS.md) and the change observation runs only while Clipboard Sync is ready.
@MainActor
final class PasteboardAccess: ObservableObject {
    @Published private(set) var reads = 0
    /// Times change observation started (a guest must never get one).
    @Published private(set) var observations = 0
    @Published private(set) var changedSinceSync = false
    private var observer: NSObjectProtocol?
    /// Read only once observation starts, never for a guest.
    private var lastCount = 0

    /// Watches `changeCount` (no content is read, so iOS shows no paste prompt) while the app is in front.
    func observe(_ on: Bool) {
        if on, observer == nil {
            observations += 1
            lastCount = UIPasteboard.general.changeCount
            observer = NotificationCenter.default
                .addObserver(forName: UIPasteboard.changedNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in self?.changed() }
                }
        } else if !on, let o = observer {
            NotificationCenter.default.removeObserver(o)
            observer = nil
            changedSinceSync = false
        }
    }

    /// Back in front: a copy made in another app shows the "new text copied" hint.
    func checkOnActive() {
        guard observer != nil else { return }
        changed()
    }

    private func changed() {
        let c = UIPasteboard.general.changeCount
        if c != lastCount {
            lastCount = c
            changedSinceSync = true
        }
    }

    func synced() {
        guard observer != nil else { return }
        lastCount = UIPasteboard.general.changeCount
        changedSinceSync = false
    }

    /// The fallback Sync button: a programmatic read, which iOS confirms with its paste prompt.
    func readString() -> String? {
        reads += 1
        return UIPasteboard.general.string
    }

    /// Text received through `PasteButton` (no prompt).
    func received() { reads += 1 }

    /// `detectPatterns` without reading the text: a bare number is a probable one-time code.
    func probableSecret() async -> Bool {
        await withCheckedContinuation { c in
            UIPasteboard.general.detectPatterns(for: [.number]) { result in
                c.resume(returning: (try? result.get())?.contains(.number) == true)
            }
        }
    }

    func write(_ text: String) {
        UIPasteboard.general.string = text
        if observer != nil { lastCount = UIPasteboard.general.changeCount }
    }
}

/// CB-1…CB-5 Clipboard (design `clipboard`): the account-required intro for guests (no pasteboard access at all),
/// Add this device, key setup or pairing, then Sync Clipboard (`PasteButton`, iOS's paste control, with a fallback
/// button), status banners, the timeline with search, item detail with Copy and Delete, and Clear history.
struct ClipboardView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var account: AccountSession
    @EnvironmentObject private var pasteboard: PasteboardAccess
    @Environment(\.palette) private var p
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: AccountSheet.Step?
    @State private var query = ""
    @State private var detail: ClipItem?
    @State private var confirmClear = false
    @State private var pendingSensitive: (text: String, kind: SensitiveKind)?
    @State private var busy = false

    private var ready: Bool { account.state.signedIn && account.state.added && account.state.keys == .ready }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                if !account.state.signedIn {
                    intro
                } else if !account.state.added {
                    addDevice
                } else if account.state.keys == .setup {
                    keyCTA(
                        title: L10n.t("product.cb_setup_h"),
                        body: L10n.t("product.cb_setup_p"),
                        action: L10n.t("product.key_setup_cta"),
                        step: .keySetup
                    )
                } else if account.state.keys == .pair {
                    keyCTA(
                        title: L10n.t("product.cb_pair_h"),
                        body: L10n.t("product.pair_p"),
                        action: L10n.t("product.pair_h"),
                        step: .keyPair
                    )
                } else if account.state.keys == .checking || account.state.keys == .none {
                    HStack(spacing: SATokens.Space.s3) {
                        ProgressView()
                        Text(L10n.t("product.keys_checking")).typeStyle(SATokens.TypeScale.body)
                    }
                } else if account.state.keys != .ready {
                    Banner(kind: .danger, title: L10n.t(keyProblem), actionTitle: L10n.t("ios_yy.retry")) {
                        Task { await account.manager.checkKeys() }
                    }
                } else {
                    syncPanel
                    timeline
                }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.clip"))
        .toolbar {
            if ready, !account.clip.items.isEmpty {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(L10n.t("ios_yy.cb_clear"), role: .destructive) { confirmClear = true }.accessibilityIdentifier("clipboard.clear")
                }
            }
        }
        .searchable(text: $query, prompt: L10n.t("ios_yy.cb_search"))
        .sheet(item: Binding(get: { sheet.map(SheetStep.init) }, set: { sheet = $0?.step })) { s in
            AccountSheet(start: s.step).environmentObject(account).environmentObject(model)
        }
        .sheet(item: $detail) { item in ClipDetail(item: item).environmentObject(account).environmentObject(pasteboard).themed() }
        .alert(L10n.t("ios_yy.cbc_h"), isPresented: $confirmClear) {
            Button(L10n.t("ios_yy.cb_clear"), role: .destructive) {
                Task {
                    do {
                        try await account.clearClipboard()
                        model.toast = L10n.t("ios_yy.n_cbcleared")
                    } catch { model.toast = L10n.t("product.cb_clear_failed") }
                }
            }
            Button(L10n.t("ios.cancel"), role: .cancel) {}
        } message: { Text(L10n.t("ios_yy.cbc_p")) }
        .onAppear { pasteboard.observe(ready) }
        .onChange(of: ready) { pasteboard.observe($0) }
        .onChange(of: scenePhase) { if $0 == .active { pasteboard.checkOnActive() } }
        .screenID("clipboard")
    }

    private var keyProblem: String {
        switch account.state.keys {
        case .legacy: "product.keys_legacy"
        case .refused: "product.keys_refused"
        case .rejected: "product.key_change_unverified"
        default: "product.keys_error"
        }
    }

    // MARK: Not ready yet

    private var intro: some View {
        VStack(alignment: .leading, spacing: SATokens.Space.s4) {
            EmptyState(icon: "doc.on.clipboard", title: L10n.t("ios_vv.k141"), message: L10n.t("ios_vv.k142"))
            Text(L10n.t("ios_vv.k144")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            PrimaryButton(title: L10n.t("ios_yy.signin")) { sheet = .signIn }.accessibilityIdentifier("clipboard.signin")
            SecondaryButton(title: L10n.t("ios_yy.create")) { sheet = .signUp }.accessibilityIdentifier("clipboard.signup")
        }
        .accessibilityIdentifier("clipboard.intro")
    }

    private var addDevice: some View {
        Card {
            Text(L10n.t("product.add_device_clipboard")).typeStyle(SATokens.TypeScale.title)
            Text(L10n.t("product.add_device_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
            PrimaryButton(title: L10n.t("product.add_device_btn")) { sheet = .trust }.accessibilityIdentifier("clipboard.add-device")
        }
    }

    private func keyCTA(title: String, body: String, action: String, step: AccountSheet.Step) -> some View {
        Card {
            Text(title).typeStyle(SATokens.TypeScale.title)
            Text(body).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
            PrimaryButton(title: action) { sheet = step }.accessibilityIdentifier("clipboard.keys")
        }
    }

    // MARK: Sync

    @ViewBuilder private var syncPanel: some View {
        let clip = account.clip
        Card {
            PasteButton(payloadType: String.self) { strings in
                guard let text = strings.first else { return }
                Task { @MainActor in
                    pasteboard.received()
                    await sync(text, flagged: false)
                }
            }
            .labelStyle(.titleAndIcon)
            .buttonBorderShape(.capsule)
            .tint(p.send)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("clipboard.sync")
            Text(L10n.t("product.cb_sync_p_ios")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            Button(L10n.t("product.cb_paste_fallback")) {
                Task { @MainActor in
                    let flagged = await pasteboard.probableSecret()
                    guard let text = pasteboard.readString() else { return model.toast = L10n.t("product.cb_empty_clip") }
                    await sync(text, flagged: flagged)
                }
            }
            .frame(minHeight: SATokens.touchTarget)
            .accessibilityIdentifier("clipboard.sync-fallback")
            Text(L10n.t("product.cb_fallback_p")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg3)
            Text(L10n.t("ios_yy.keep7")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg3)
        }
        if pasteboard.changedSinceSync {
            Banner(kind: .info, title: L10n.t("product.cb_new_copy_ios")).accessibilityIdentifier("clipboard.changed")
        }
        if let pending = pendingSensitive {
            Banner(
                kind: .warning,
                title: L10n.t("product.cb_sensitive_h"),
                message: L10n.t("product.cb_sensitive_p"),
                actionTitle: L10n.t("product.cb_sync_anyway")
            ) {
                pendingSensitive = nil
                Task { await sync(pending.text, flagged: false, force: true) }
            }
            .accessibilityIdentifier("clipboard.sensitive")
        }
        if clip.settings?.paused == true {
            Banner(kind: .info, title: L10n.t("product.cb_queued_paused"), actionTitle: L10n.t("product.cb_resume")) {
                Task {
                    var s = clip.settings!
                    s.paused = false
                    try? await account.saveClipboardSettings(s)
                }
            }
        }
        if clip.loadError == .offline || clip.sendError == .offline {
            Banner(
                kind: .warning,
                title: clip.queued > 0
                    ? (clip.queued == 1 ? L10n.t("product.cb_offline_1") : L10n.t("product.cb_offline_n", ["n": "\(clip.queued)"]))
                    : L10n.t("product.cb_offline_cached")
            )
            .accessibilityIdentifier("clipboard.offline")
        } else if clip.loadError == .error {
            Banner(kind: .danger, title: L10n.t("product.cb_load_failed"), actionTitle: L10n.t("ios_yy.retry")) {
                Task { await account.refreshClipboard() }
            }
        }
        if clip.sendError == .key { Banner(kind: .warning, title: L10n.t("product.cb_send_key")) }
        if clip.sendError == .rateLimited { Banner(kind: .warning, title: L10n.t("product.cb_rate_limited")) }
        ForEach(clip.skipped) { s in
            Banner(
                kind: .info,
                title: L10n.t(s.kind == .flagged ? "product.cb_flagged_row" : "product.cb_skipped_row"),
                actionTitle: L10n.t("product.cb_dismiss")
            ) { Task { await account.dismissSkipped(s.id) } }
        }
    }

    private func sync(_ text: String, flagged: Bool, force: Bool = false) async {
        busy = true
        defer { busy = false }
        let r = await account.capture(text, force: force, flagged: flagged)
        pasteboard.synced()
        switch r {
        case .synced: model.toast = L10n.t("product.cb_synced")
        case let .queued(_, reason): model.toast = L10n.t(queuedKey(reason))
        case let .sensitive(kind): pendingSensitive = (text, kind)
        case .duplicate: model.toast = L10n.t("product.cb_duplicate")
        case .empty: model.toast = L10n.t("product.cb_empty_clip")
        case .tooLarge: model.toast = L10n.t("product.cb_too_large")
        case .paused: model.toast = L10n.t("product.cb_queued_paused")
        case .removed: break
        case .notReady: model.toast = L10n.t("product.error_generic")
        }
    }

    private func queuedKey(_ r: QueueReason) -> String {
        switch r {
        case .offline: "product.cb_queued"
        case .busy: "product.cb_queued_busy"
        case .rateLimited: "product.cb_queued_rate_limited"
        case .key: "product.cb_queued_key"
        case .paused: "product.cb_queued_paused"
        case .pending: "product.cb_queued"
        }
    }

    // MARK: Timeline

    @ViewBuilder private var timeline: some View {
        let clip = account.clip
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let items = q.isEmpty ? clip.items : clip.items.filter { $0.text?.lowercased().contains(q) == true }
        if !clip.loaded || (!clip.synced && clip.items.isEmpty && clip.loadError == nil) {
            HStack(spacing: SATokens.Space.s3) {
                ProgressView()
                Text(L10n.t("product.cb_loading")).typeStyle(SATokens.TypeScale.body)
            }
        } else if clip.items.isEmpty {
            EmptyState(icon: "tray", title: L10n.t("ios_yy.cb_empty_h"), message: L10n.t("ios_yy.cb_empty_p"))
                .accessibilityIdentifier("clipboard.empty")
        } else if items.isEmpty {
            Text(L10n.t("ios_yy.nomatch")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
        } else {
            VStack(spacing: 0) {
                ForEach(items) { item in
                    Button { detail = item } label: { ClipRow(item: item, mine: item.origin == account.state.deviceId) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("clipboard.item")
                    Divider()
                }
            }
        }
    }
}

private struct SheetStep: Identifiable {
    let step: AccountSheet.Step
    var id: String { "\(step)" }
}

struct ClipRow: View {
    let item: ClipItem
    let mine: Bool
    @Environment(\.palette) private var p

    var body: some View {
        HStack(alignment: .top, spacing: SATokens.Space.s3) {
            Image(systemName: item.text == nil ? "lock" : mine ? "iphone" : "laptopcomputer").foregroundStyle(p.fg2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.text ?? L10n.t("product.cb_locked_device")).typeStyle(SATokens.TypeScale.body)
                    .foregroundStyle(item.text == nil ? p.fg3 : p.fg)
                    .lineLimit(3)
                HStack(spacing: SATokens.Space.s2) {
                    Text(mine ? L10n.t("product.cb_this_device") : L10n.t("product.cb_other_device"))
                    Text(L10n.t("product.cb_chars", ["n": "\(item.size)"]))
                    if item.pending { Chip(text: L10n.t("product.cb_queued_label")) }
                    if item.incoming { Chip(text: L10n.t("product.cb_new"), color: p.sendInk) }
                }
                .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, SATokens.Space.s3)
        .frame(minHeight: SATokens.touchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// CB-5 item detail: the full text, Copy, Delete on every device.
struct ClipDetail: View {
    let item: ClipItem
    @EnvironmentObject private var account: AccountSession
    @EnvironmentObject private var pasteboard: PasteboardAccess
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var p
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                    Text(item.text ?? L10n.t("product.cb_locked_device")).typeStyle(SATokens.TypeScale.body).textSelection(.enabled)
                        .accessibilityIdentifier("clipboard.detail-text")
                    if let error { Banner(kind: .danger, title: error) }
                    if let text = item.text {
                        PrimaryButton(title: L10n.t("ios_yy.copy")) {
                            pasteboard.write(text)
                            Task { await account.markCopied(item.id) }
                            dismiss()
                        }
                        .accessibilityIdentifier("clipboard.copy")
                    }
                    PrimaryButton(title: L10n.t("ios_yy.del"), tone: .danger) {
                        Task {
                            do {
                                try await account.remove(item.id)
                                dismiss()
                            } catch { self.error = L10n.t("product.cb_delete_failed") }
                        }
                    }
                    .accessibilityIdentifier("clipboard.delete")
                }
                .padding(SATokens.Space.s4)
            }
            .navigationTitle(L10n.t("ios_yy.cb_detail"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L10n.t("ios_yy.close")) { dismiss() } } }
        }
    }
}
