import SATransferRuntime
import SwiftUI

/// Cloud Distribution on iOS (docs/TRANSFER_PROTOCOL.md §9, PRD §2 "iOS long transfers", §6.6): the TR-3 option with
/// its consent sheet, the Settings section, and the upload card on the session screen.

private let gib: Double = 1024 * 1024 * 1024

private func money(_ amount: Double, _ currency: String) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = currency
    f.maximumFractionDigits = 4
    return f.string(from: NSNumber(value: amount)) ?? String(format: "%.4f %@", amount, currency)
}

/// TR-3 Cloud option. Hidden when the server has no Cloud; for a guest, disabled with "Sign in to let large transfers
/// finish in the background" (`product.ios_cloud_signin`); for a signed-in sender, turning it on shows the estimate and
/// asks for consent each time, turning Cloud on in the account (with consent) when needed.
struct CloudSendOption: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @Binding var on: Bool
    /// Loaded by the parent on a view that is always on screen: this view is empty until settings arrive, and SwiftUI
    /// runs no `.task` on an empty view.
    @Binding var settings: CloudSettings?
    let total: Int64
    let signIn: () -> Void
    @State private var estimate: CloudEstimate?
    @State private var asking = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Group {
            if let settings, settings.available {
                if !settings.signedIn {
                    guest
                } else if !settings.deviceAdded {
                    notAdded
                } else {
                    signedIn(settings)
                }
            }
        }
        .sheet(isPresented: $asking) { consent.themed() }
    }

    private var notAdded: some View {
        Toggle(isOn: .constant(false)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L10n.t("product.cloud_option")).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg2)
                Text(L10n.t("product.cloud_add_device")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            }
        }
        .disabled(true)
        .padding(SATokens.Space.s4)
        .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.lg))
        .accessibilityIdentifier("send.cloud")
    }

    private var guest: some View {
        VStack(alignment: .leading, spacing: SATokens.Space.s2) {
            Toggle(isOn: .constant(false)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n.t("product.cloud_option")).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg2)
                    Text(L10n.t("product.ios_cloud_signin")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                        .accessibilityIdentifier("send.cloud-signin")
                }
            }
            .disabled(true)
            .accessibilityIdentifier("send.cloud")
            Button(L10n.t("ios_yy.signin"), action: signIn).frame(minHeight: SATokens.touchTarget)
                .accessibilityIdentifier("send.cloud-signin-btn")
        }
        .padding(SATokens.Space.s4)
        .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.lg))
    }

    private func signedIn(_: CloudSettings) -> some View {
        VStack(alignment: .leading, spacing: SATokens.Space.s2) {
            Toggle(isOn: Binding(get: { on }, set: { v in v ? ask() : (on = false) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n.t("product.cloud_option")).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
                    Text(L10n.t("product.cloud_option_p")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                }
            }
            .accessibilityIdentifier("send.cloud")
            if let error { Text(error).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.dangerInk) }
        }
        .padding(SATokens.Space.s4)
        .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.lg))
    }

    private func ask() {
        error = nil
        estimate = nil
        asking = true
        Task {
            do { estimate = try await model.hub.services.estimateCloud(bytes: total, receivers: 5) } catch {
                asking = false
                self.error = L10n.t("product.cloud_unavailable")
            }
        }
    }

    private var consent: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SATokens.Space.s3) {
                    Text(L10n.t("ios_xx.cloud_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg)
                    // PRD §2: on iOS, Cloud is what lets a large transfer finish while the app is not in the foreground.
                    Text(L10n.t("product.cloud_ios_background")).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
                        .accessibilityIdentifier("cloud.background")
                    if let e = estimate {
                        Card {
                            Text(L10n.t("product.cloud_storage", ["size": formatBytes(e.storageBytes)]))
                            Text(L10n.t("product.cloud_egress", ["size": formatBytes(e.egressBytes)]))
                            Text(L10n.t("product.cloud_retention", ["hours": "\(e.retentionHours)"]))
                            Text(
                                e.cost.map { L10n.t("product.cloud_cost", ["amount": money($0, e.currency ?? "USD")]) } ?? L10n
                                    .t("product.cost_unknown")
                            )
                            .accessibilityIdentifier("cloud.cost")
                            Text(L10n.t(
                                "product.cloud_budget_line",
                                ["used": formatBytes(e.usedBytes), "budget": formatBytes(e.budgetBytes)]
                            ))
                            .foregroundStyle(p.fg2)
                        }
                        .typeStyle(SATokens.TypeScale.body)
                        if !e.withinBudget { Banner(kind: .danger, title: L10n.t("product.cloud_over_budget")) }
                    } else {
                        ProgressView(L10n.t("product.cloud_estimating"))
                    }
                    Text(L10n.t("product.cloud_encrypted_p")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    PrimaryButton(title: L10n.t("product.cloud_approve"), enabled: estimate?.withinBudget == true && !busy) { approve() }
                        .accessibilityIdentifier("cloud.approve")
                }
                .padding(SATokens.Space.s4)
            }
            .background(p.bg.ignoresSafeArea())
            .navigationTitle(L10n.t("ios_xx.cloud_h"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.t("ios_yy.cancel")) { asking = false }.accessibilityIdentifier("cloud.cancel")
                }
            }
        }
        .screenID("cloud-consent")
    }

    private func approve() {
        busy = true
        Task {
            defer { busy = false }
            do {
                if settings?.enabled != true || settings?.consented != true {
                    settings = try await model.hub.services.putCloudSettings(enabled: true, consent: true, budgetBytes: nil)
                }
                on = true
                asking = false
            } catch {
                self.error = L10n.t("product.cloud_consent_needed")
                asking = false
            }
        }
    }
}

/// ST-1 Cloud Distribution section for a signed-in account: the switch (consent the first time), the monthly budget
/// and this month's use. Plus the Transfer strategy row (Auto), shown to everyone for transparency.
struct CloudSettingsSection: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    let signedIn: Bool
    @State private var settings: CloudSettings?
    @State private var consenting = false
    @State private var budget = ""
    @State private var failed = false
    @State private var budgetError: String?

    var body: some View {
        Section(
            header: Text(L10n.t("ios_yy.s_strategy")).foregroundStyle(p.fg2),
            footer: Text(L10n.t("ios_yy.st_auto_p")).foregroundStyle(p.fg2)
        ) {
            HStack {
                Text(L10n.t("ios_yy.s_strategy"))
                Spacer()
                Text(L10n.t("ios_yy.st_auto")).foregroundStyle(p.fg2)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings.strategy")
            if signedIn, let s = settings, s.available { cloudRows(s) }
        }
        .task { await load() }
        .alert(L10n.t("ios_xx.cloud_h"), isPresented: $consenting) {
            Button(L10n.t("ios_yy.cancel"), role: .cancel) {}
            Button(L10n.t("product.cloud_approve")) { save(enabled: true, consent: true) }
        } message: {
            Text("\(L10n.t("product.cloud_consent_settings_p"))\n\n\(L10n.t("product.cloud_ios_background"))")
        }
    }

    @ViewBuilder private func cloudRows(_ s: CloudSettings) -> some View {
        Toggle(isOn: Binding(
            get: { s.enabled },
            set: { v in v && !s.consented ? (consenting = true) : save(enabled: v, consent: false) }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L10n.t("ios_yy.s_cloud"))
                Text(L10n.t(s.deviceAdded ? "ios_yy.s_cloud_p" : "product.cloud_add_device"))
                    .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            }
        }
        .disabled(!s.deviceAdded)
        .accessibilityIdentifier("settings.cloud")
        if s.enabled {
            HStack {
                Text(L10n.t("product.cloud_budget_gb"))
                Spacer()
                TextField("10", text: $budget).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(maxWidth: 90)
                    .accessibilityIdentifier("settings.cloud-budget")
                Button(L10n.t("product.cloud_budget_save")) {
                    let max = Double(s.maxBudgetBytes) / gib
                    if let gb = Double(budget.replacingOccurrences(of: ",", with: ".")), gb >= 0, gb <= max {
                        budgetError = nil
                        save(enabled: true, consent: false, budget: Int64(gb * gib))
                    } else {
                        budgetError = L10n.t("product.cloud_budget_invalid", ["max": String(Int(max))])
                    }
                }
                .accessibilityIdentifier("settings.cloud-budget-save")
            }
            Text(L10n.t("product.cloud_budget_used", ["used": formatBytes(s.usedBytes), "budget": formatBytes(s.budgetBytes)]))
                .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                .accessibilityIdentifier("settings.cloud-usage")
        }
        if let budgetError {
            Text(budgetError).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.dangerInk)
                .accessibilityIdentifier("settings.cloud-budget-error")
        }
        if failed { Text(L10n.t("product.error_generic")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.dangerInk) }
    }

    private func load() async {
        guard let s = try? await model.hub.services.cloudSettings() else { return }
        settings = s
        budget = String(format: "%.1f", Double(s.budgetBytes) / gib)
    }

    private func save(enabled: Bool, consent: Bool, budget bytes: Int64? = nil) {
        Task {
            do {
                settings = try await model.hub.services.putCloudSettings(enabled: enabled, consent: consent, budgetBytes: bytes)
                failed = false
                if let s = settings { budget = String(format: "%.1f", Double(s.budgetBytes) / gib) }
            } catch {
                failed = true
            }
        }
    }
}

/// The sender's Cloud upload on the session screen: progress, ready ("receivers can download even if you go
/// offline"), paused or failed with the reason.
struct CloudUploadCard: View {
    @Environment(\.palette) private var p
    let state: CloudUploadState

    var body: some View {
        let total = state.files.reduce(Int64(0)) { $0 + $1.size }
        let done = state.files.reduce(Int64(0)) { $0 + $1.uploaded }
        Card {
            HStack(spacing: SATokens.Space.s2) {
                Image(systemName: "icloud.and.arrow.up").foregroundStyle(p.sendInk).accessibilityHidden(true)
                Text(state.ready ? L10n.t("product.cloud_ready") : state.paused ? L10n.t("product.cloud_paused") : L10n.t(
                    "product.cloud_uploading",
                    ["done": formatBytes(done), "total": formatBytes(total)]
                ))
                .typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
            }
            if !state.ready { TransferBar(done: done, total: total, tint: p.send) }
            if let e = state.error { Banner(kind: .warning, title: L10n.t(e)) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.cloud")
        .accessibilityValue(state.ready ? "ready" : state.paused ? "paused" : "uploading")
    }
}
