import SATransferRuntime
import SwiftUI

/// RX-4 Join preview (design `rx-preview`): sender, files and total, the join window counting down, protected mode,
/// and Receive, which joins with the single-use ticket. Open join lands straight in the receive screen; approval or
/// protected mode waits there for the sender (RX-5).
struct JoinPreviewView: View {
    let sessionId: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @State private var joining = false
    @State private var error: String?
    @State private var offset: TimeInterval = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                if let preview = model.previews[sessionId] {
                    content(preview)
                } else {
                    Banner(kind: .danger, title: L10n.t("product.session_ended_rx"))
                }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("product.rx_incoming"))
        .navigationBarTitleDisplayMode(.inline)
        // Server time minus device time, measured once when the preview arrives, so the countdown follows the server.
        .onAppear {
            if let p = model.previews[sessionId], let server = ISO8601.parse(p.serverTime) { offset = server.timeIntervalSinceNow }
        }
        .screenID("rx-preview")
    }

    @ViewBuilder private func content(_ preview: JoinPreview) -> some View {
        let n = preview.fileCount
        Card {
            Text(n == 1 ? L10n.t("product.preview_title_one", ["name": preview.sender.displayName]) : L10n.t(
                "product.preview_title",
                ["name": preview.sender.displayName, "n": "\(n)"]
            ))
            .typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
            .accessibilityIdentifier("preview.title")
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let left = secondsLeft(preview, ctx.date)
                Text(L10n.t(
                    "product.rx_sender_line",
                    ["platform": platformName(preview.sender.platform), "time": TransferText.clock(left)]
                ))
                .typeStyle(SATokens.TypeScale.caption).foregroundStyle(left < 60 ? p.warningInk : p.fg2)
            }
        }
        Card {
            ForEach(preview.files, id: \.id) { f in
                HStack {
                    Image(systemName: "doc").foregroundStyle(p.fg2).accessibilityHidden(true)
                    Text(f.name).typeStyle(SATokens.TypeScale.body).lineLimit(2)
                    Spacer()
                    Text(formatBytes(f.size)).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                }
                .accessibilityElement(children: .combine)
            }
            Divider()
            HStack {
                Text(L10n.t("ios.total")).typeStyle(SATokens.TypeScale.labelLg)
                Spacer()
                Text("\(TransferText.files(n)) · \(formatBytes(preview.totalBytes))").typeStyle(SATokens.TypeScale.body)
            }
        }
        if preview.protectedMode { Banner(kind: .warning, title: L10n.t("product.protected_mode")) }
        Text(L10n.t("product.preview_secure")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
        if let error {
            Banner(kind: .danger, title: error, actionTitle: L10n.t("product.another_code")) { model.homePath.removeLast() }
                .accessibilityIdentifier("preview.error")
        }
        PrimaryButton(title: joining ? L10n.t("product.joining") : L10n.t("product.receive_cta"), tone: .receive, enabled: !joining) {
            join(preview)
        }
        .accessibilityIdentifier("preview.receive")
    }

    private func secondsLeft(_ preview: JoinPreview, _ now: Date) -> Int {
        guard let ends = ISO8601.parse(preview.joinWindowEndsAt) else { return 0 }
        return Int(ends.timeIntervalSince(now.addingTimeInterval(offset)).rounded(.up))
    }

    private func join(_ preview: JoinPreview) {
        joining = true
        error = nil
        Task {
            defer { joining = false }
            do {
                _ = try await model.hub.services.join(sessionId: preview.sessionId, ticket: preview.joinTicket)
                model.homePath.removeLast()
                model.homePath.append(.receiving(preview.sessionId))
            } catch {
                self.error = JoinErrors.message(error)
            }
        }
    }
}
