import SAAPIClient
import SAStore
import SwiftUI

/// TR-1 Transfer home (design `home`): identity notices (ON-2) and recent local transfers. Send and Receive arrive
/// with the transfer screens (milestone 7.3); until then there is no button that does nothing.
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
                recent
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.home"))
        .navigationBarTitleDisplayMode(.inline)
        .screenID("home")
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
