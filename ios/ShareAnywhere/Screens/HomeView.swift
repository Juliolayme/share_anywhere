import SAAPIClient
import SAStore
import SwiftUI

/// TR-1 Transfer home (design `home`): Send and Receive, identity notices (ON-2), the transfer in progress, and recent
/// local transfers. Sending and receiving never need an account (PRD §2).
struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                HStack {
                    LogoMark(size: 32, wordmark: true)
                    Spacer()
                    Chip(text: L10n.t("ios.guest")).accessibilityIdentifier("home.guest")
                }
                IdentityNotice()
                actions
                ActiveTransfers()
                recent
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.home"))
        .navigationBarTitleDisplayMode(.inline)
        .screenID("home")
    }

    private var actions: some View {
        VStack(spacing: SATokens.Space.s3) {
            HomeTile(title: L10n.t("ios.send"), subtitle: L10n.t("ios.send_sub"), icon: "arrow.up.circle.fill", tone: .send) {
                model.homePath.append(.send)
            }
            .accessibilityIdentifier("home.send")
            HomeTile(title: L10n.t("ios.receive"), subtitle: L10n.t("ios.receive_sub"), icon: "arrow.down.circle.fill", tone: .receive) {
                model.homePath.append(.receive)
            }
            .accessibilityIdentifier("home.receive")
        }
    }

    @ViewBuilder private var recent: some View {
        HStack {
            Text(L10n.t("ios.recent")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
            Spacer()
            if !model.historyEntries.isEmpty {
                Button(L10n.t("product.see_all")) { model.tab = .history }
                    .frame(minHeight: SATokens.touchTarget)
                    .accessibilityIdentifier("home.see-all")
            }
        }
        if !model.historyLoaded {
            ProgressView().frame(maxWidth: .infinity).padding(SATokens.Space.s6)
        } else if model.historyEntries.isEmpty {
            EmptyState(icon: "tray", title: L10n.t("ios_yy.empty_h"), message: L10n.t("ios_yy.empty_p"))
                .accessibilityIdentifier("home.empty")
        } else {
            VStack(spacing: 0) {
                ForEach(model.historyEntries.prefix(5)) { e in
                    HistoryRow(entry: e)
                        .contentShape(Rectangle())
                        .onTapGesture { model.tab = .history }
                    Divider()
                }
            }
        }
    }
}

/// ON-2: the anonymous identity's state, inline on Transfer home.
struct IdentityNotice: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let s = model.identityState
        Group {
            if s.replaced {
                Banner(kind: .info, title: L10n.t("product.identity_replaced"), actionTitle: L10n.t("ios_yy.close")) {
                    model.dismissReplaced()
                }
            }
            switch s.status {
            case .loading, .solvingChallenge:
                HStack(spacing: SATokens.Space.s3) {
                    ProgressView()
                    Text(L10n.t("product.identity_loading")).typeStyle(SATokens.TypeScale.body)
                }
                .accessibilityIdentifier("home.identity-loading")
            case .offline:
                Banner(
                    kind: .warning,
                    title: L10n.t("ios_yy.off_h"),
                    message: L10n.t("product.identity_offline"),
                    actionTitle: L10n.t("ios_yy.retry")
                ) {
                    model.retryIdentity()
                }
                .accessibilityIdentifier("home.identity-offline")
            case .rateLimited:
                RateLimitedNotice(retryAt: s.retryAt)
            case .failed:
                Banner(
                    kind: .danger,
                    title: L10n.t("product.identity_failed"),
                    message: L10n.t("product.error_generic"),
                    actionTitle: L10n.t("ios_yy.retry")
                ) {
                    model.retryIdentity()
                }
                .accessibilityIdentifier("home.identity-failed")
            case .ready:
                EmptyView()
            }
        }
    }
}

struct RateLimitedNotice: View {
    let retryAt: Date?
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let left = max(0, Int((retryAt ?? ctx.date).timeIntervalSince(ctx.date)))
            Banner(
                kind: .warning,
                title: L10n.t("product.acct_rate_limited"),
                message: L10n.t("product.retry_in", ["time": String(format: "%d:%02d", left / 60, left % 60)])
            )
        }
        .accessibilityIdentifier("home.identity-rate-limited")
    }
}

/// A large Send / Receive action (Hero buttons).
struct HomeTile: View {
    let title: String
    let subtitle: String
    let icon: String
    let tone: PrimaryButton.Tone
    let action: () -> Void
    @Environment(\.palette) private var p

    var body: some View {
        Button(action: action) {
            HStack(spacing: SATokens.Space.s3) {
                Image(systemName: icon).font(.system(size: 30)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).typeStyle(SATokens.TypeScale.title)
                    Text(subtitle).typeStyle(SATokens.TypeScale.caption).opacity(0.9)
                }
                Spacer()
                Image(systemName: "chevron.right").accessibilityHidden(true)
            }
            .padding(SATokens.Space.s4)
            .frame(maxWidth: .infinity, minHeight: 72)
            .foregroundStyle(tone == .receive ? p.onReceive : p.onSend)
            .background(tone == .receive ? p.receive : p.send, in: RoundedRectangle(cornerRadius: SATokens.Radius.lg))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// The transfers moving now, with a way back to their screen (TR-1 active transfer card).
struct ActiveTransfers: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var hub: TransferHub

    var body: some View {
        let live = hub.active.filter(\.value).keys.sorted()
        ForEach(live, id: \.self) { key in
            let id = String(key.dropFirst(3))
            Banner(
                kind: .info,
                title: key.hasPrefix("tx:") ? L10n.t("ios_yy.live") : L10n.t("ios.receiving"),
                actionTitle: L10n.t("ios_yy.open")
            ) {
                model.homePath.append(key.hasPrefix("tx:") ? .session(id) : .receiving(id))
            }
            .accessibilityIdentifier("home.active")
        }
    }
}
