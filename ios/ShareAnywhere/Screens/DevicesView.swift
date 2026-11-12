import SAAPIClient
import SwiftUI

/// DV-1 / DV-2 Devices (design `devices`): the "This device" card with Rename and Reset device identity; signed in and
/// added, the account's devices (DV-2); a guest sees why signing in shows the device list.
struct DevicesView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var renaming = false
    @State private var confirmReset = false
    @State private var accountSheet: AccountSheet.Step?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Card {
                    Text(L10n.t("ios_yy.dv_this")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    if let d = model.identityState.device {
                        Text(d.displayName).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
                            .accessibilityIdentifier("devices.name")
                        Text("iOS · \(UIDevice.current.model)").typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                        Text(L10n.t("product.anon_since", ["date": anonSince(d.createdAt)])).typeStyle(SATokens.TypeScale.caption)
                            .foregroundStyle(p.fg3)
                        HStack(spacing: SATokens.Space.s3) {
                            SecondaryButton(title: L10n.t("ios_yy.rename")) { renaming = true }.accessibilityIdentifier("devices.rename")
                            SecondaryButton(title: L10n.t("product.reset_identity")) { confirmReset = true }
                                .accessibilityIdentifier("devices.reset")
                        }
                    } else {
                        IdentityNotice()
                        if model.identityState.status == .loading || model.identityState.status == .solvingChallenge {
                            Text(L10n.t("product.identity_loading")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                        }
                    }
                }
                .screenID("devices.this-device")
                if account.state.signedIn, account.state.added {
                    AccountDevicesSection()
                } else if model.config.accounts {
                    Card {
                        Text(L10n.t("ios_yy.dv_sync_h")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
                        Text(L10n.t("ios_yy.dv_sync_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                        PrimaryButton(title: L10n.t(account.state.signedIn ? "product.add_device_btn" : "ios_yy.signin")) {
                            accountSheet = account.state.signedIn ? .trust : .signIn
                        }
                        .accessibilityIdentifier("devices.signin")
                    }
                }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.dev"))
        .sheet(isPresented: $renaming) {
            RenameSheet(current: model.identityState.device?.displayName ?? "").themed()
        }
        .sheet(item: Binding(get: { accountSheet.map(AccountSheetItem.init) }, set: { accountSheet = $0?.step })) { item in
            AccountSheet(start: item.step).environmentObject(account).environmentObject(model)
        }
        .confirmationDialog(L10n.t("product.reset_identity"), isPresented: $confirmReset, titleVisibility: .visible) {
            Button(L10n.t("product.reset_identity"), role: .destructive) {
                Task {
                    await model.resetIdentity()
                    model.toast = L10n.t("product.reset_done")
                }
            }
        } message: {
            Text(L10n.t("product.reset_identity_p"))
        }
        .screenID("devices")
    }

    private func anonSince(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        return d?.formatted(date: .abbreviated, time: .omitted) ?? iso
    }
}

/// Rename device (design rename sheet): 1–60 characters.
struct RenameSheet: View {
    let current: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                TextField(L10n.t("ios_yy.name"), text: $name)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.done)
                    .accessibilityIdentifier("rename.field")
            }
            .navigationTitle(L10n.t("ios_xx.rn_h"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L10n.t("ios_yy.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.t("ios_yy.save")) {
                        saving = true
                        Task {
                            if await model.rename(trimmed) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(trimmed.isEmpty || trimmed.count > 60 || saving)
                    .accessibilityIdentifier("rename.save")
                }
            }
        }
        .onAppear { name = current }
        .presentationDetents([.medium])
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
}
