import SATransferRuntime
import SwiftUI
import UniformTypeIdentifiers

/// TR-2 / TR-3 Send (design `send`): files picked with the document picker (security-scoped, read in place), total
/// with the 20 GB limit, Require approval (off by default), Create share session. When the device already has its
/// maximum of open sessions, they are listed with Close (TR-3 open-session cap).
struct SendView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @State private var files: [PickedFile] = []
    @EnvironmentObject private var account: AccountSession
    @State private var requireApproval = false
    @State private var cloud = false
    @State private var cloudSettings: CloudSettings?
    @State private var accountSheet: AccountSheet.Step?
    @State private var picking = false
    @State private var creating = false
    @State private var error: String?
    @State private var openSessions: OpenSessionList?
    @State private var seeded = false

    static let limit: Int64 = 20 * 1000 * 1000 * 1000

    private var total: Int64 { files.reduce(0) { $0 + $1.size } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                if files.isEmpty {
                    EmptyState(icon: "doc.badge.plus", title: L10n.t("product.send_empty_h"), message: L10n.t("product.send_empty_p_ios"))
                        .accessibilityIdentifier("send.empty")
                    PrimaryButton(title: L10n.t("product.step_choose")) { picking = true }
                        .accessibilityIdentifier("send.choose")
                } else {
                    fileList
                    approval
                    CloudSendOption(on: $cloud, settings: $cloudSettings, total: total) { accountSheet = .signIn }
                    if let error { Banner(kind: .danger, title: error).accessibilityIdentifier("send.error") }
                    if let openSessions { OpenSessionsPanel(list: openSessions) { self.openSessions = nil } }
                    PrimaryButton(title: L10n.t("ios.create"), enabled: !creating && total <= SendView.limit) { create() }
                        .accessibilityIdentifier("send.create")
                    if creating { ProgressView().frame(maxWidth: .infinity) }
                }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.send"))
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            var unreadable: [String] = []
            for url in urls {
                if let f = PickedFile.from(url) { files.append(f) } else { unreadable.append(url.lastPathComponent) }
            }
            error = unreadable.isEmpty ? nil : L10n.t("product.file_unreadable", ["name": unreadable.joined(separator: ", ")])
        }
        .onAppear(perform: seedForTests)
        .task(id: account.state.signedIn) { await loadCloudSettings() }
        .sheet(item: Binding(get: { accountSheet.map(AccountSheetItem.init) }, set: { accountSheet = $0?.step })) { item in
            AccountSheet(start: item.step).environmentObject(account).environmentObject(model)
        }
        .screenID("send")
    }

    @ViewBuilder private var fileList: some View {
        Card {
            ForEach(files) { f in
                HStack(spacing: SATokens.Space.s3) {
                    Image(systemName: "doc").foregroundStyle(p.fg2).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(f.name).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg).lineLimit(2)
                        Text(formatBytes(f.size)).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    }
                    Spacer()
                    Button {
                        files.removeAll { $0.id == f.id }
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(p.fg3)
                            .frame(minWidth: SATokens.touchTarget, minHeight: SATokens.touchTarget)
                    }
                    .accessibilityLabel(L10n.t("product.remove_file", ["name": f.name]))
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("send.file")
            }
            Divider()
            HStack {
                Text(L10n.t("ios.total")).typeStyle(SATokens.TypeScale.labelLg)
                Spacer()
                Text("\(TransferText.files(files.count)) · \(formatBytes(total))").typeStyle(SATokens.TypeScale.body)
                    .accessibilityIdentifier("send.total")
            }
            if total > SendView.limit {
                Text(L10n.t("product.over_limit", ["amount": formatBytes(total - SendView.limit)]))
                    .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.dangerInk)
            }
            Button(L10n.t("product.add_more")) { picking = true }
                .frame(minHeight: SATokens.touchTarget)
                .accessibilityIdentifier("send.add")
        }
    }

    private var approval: some View {
        Toggle(isOn: $requireApproval) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L10n.t("ios.reqappr")).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
                Text(L10n.t(requireApproval ? "product.appr_on" : "product.appr_off"))
                    .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            }
        }
        .padding(SATokens.Space.s4)
        .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.lg))
        .accessibilityIdentifier("send.approval")
    }

    private func create() {
        creating = true
        error = nil
        Task {
            defer { creating = false }
            do {
                let view = try await model.hub.createSession(files: files, requireApproval: requireApproval, cloud: cloud)
                model.homePath.removeLast(model.homePath.count)
                model.homePath.append(.session(view.id))
            } catch let e as APIError where e.code == "too_many_open_sessions" {
                error = L10n.t("product.too_many_open")
                openSessions = try? await model.hub.services.listOpen()
            } catch let e as APIError where e.code == "over_limit" {
                error = L10n.t("product.over_limit", ["amount": formatBytes(max(0, total - SendView.limit))])
            } catch is NetworkError {
                error = L10n.t("ios_yy.off_h")
            } catch {
                self.error = L10n.t("product.error_generic")
            }
        }
    }

    /// `-uiTesting -seedSendFiles N`: N generated files in the app's temporary folder, picked through the same path as
    /// the document picker (bookmarks), so XCUITests do not drive the system picker.
    /// Cloud availability for the TR-3 option, retried a few times so one failed request does not hide it.
    private func loadCloudSettings() async {
        for attempt in 0 ..< 3 {
            if let s = try? await model.hub.services.cloudSettings() {
                cloudSettings = s
                return
            }
            try? await Task.sleep(nanoseconds: UInt64(attempt + 1) * 2_000_000_000)
        }
    }

    private func seedForTests() {
        guard !seeded, model.config.uiTesting, model.config.seedSendFiles > 0, files.isEmpty else { return }
        seeded = true
        for i in 0 ..< model.config.seedSendFiles {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("sa-seed-\(i + 1).bin")
            try? SendView.seedContent(index: i, size: model.config.seedFileBytes).write(to: url)
            if let f = PickedFile.from(url) { files.append(f) }
        }
    }

    /// Test content: a 64 KiB pattern per file, each block stamped with its index (fast to build in Debug builds).
    /// The UI tests' `TestPeer.seededContent` builds the same bytes to check the receiver's SHA-256.
    static func seedContent(index: Int, size: Int) -> Data {
        var block = [UInt8](repeating: 0, count: 65536)
        for j in 0 ..< block.count {
            block[j] = UInt8(truncatingIfNeeded: (j &* 31) ^ (index &* 7) ^ (j >> 9))
        }
        var out = Data(capacity: size)
        var k: UInt64 = 0
        while out.count < size {
            var b = block
            withUnsafeBytes(of: k.littleEndian) { stamp in
                for (i, byte) in stamp.enumerated() {
                    b[i] ^= byte
                }
            }
            out.append(contentsOf: b.prefix(size - out.count))
            k += 1
        }
        return out
    }
}

/// The device's open sessions with Open and Close (`GET /v1/sessions`), shown when the open-session cap is reached.
struct OpenSessionsPanel: View {
    let list: OpenSessionList
    let onClosed: () -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @State private var closing: String?

    var body: some View {
        Card {
            Text(L10n.t("product.open_sessions_h")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
            Text(L10n.t("product.open_sessions_p", ["max": "\(list.maxOpen)"])).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            ForEach(list.sessions, id: \.id) { s in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.firstFileName).typeStyle(SATokens.TypeScale.body)
                        Text(TransferText.files(s.fileCount) + " · " + formatBytes(s.totalBytes))
                            .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    }
                    Spacer()
                    Button(L10n.t("ios.close")) { close(s.id) }
                        .disabled(closing != nil)
                        .frame(minHeight: SATokens.touchTarget)
                        .accessibilityLabel(L10n.t("product.open_session_close_named", ["name": s.firstFileName]))
                }
            }
        }
        .accessibilityIdentifier("send.open-sessions")
    }

    private func close(_ id: String) {
        closing = id
        Task {
            defer { closing = nil }
            do {
                try await model.hub.services.close(id)
                model.hub.release(id)
                model.toast = L10n.t("product.open_session_closed")
                onClosed()
            } catch {
                model.toast = L10n.t("product.close_failed")
            }
        }
    }
}
