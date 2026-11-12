import SAAccount
import SwiftUI

/// DV-2 for a signed-in, added device: the account's devices with Rename and Revoke (remembered before the request,
/// then a key rotation that leaves the revoked device out), and Pair a new device.
struct AccountDevicesSection: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var renaming: AccountDevice?
    @State private var revoking: AccountDevice?
    @State private var pairing = false
    @State private var newName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: SATokens.Space.s3) {
            HStack {
                Text(L10n.t("ios.dev")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
                Spacer()
                if account.state.keys == .ready {
                    Button(L10n.t("product.pair_device")) { pairing = true }.frame(minHeight: SATokens.touchTarget)
                        .accessibilityIdentifier("devices.pair")
                }
            }
            Text(L10n.t("ios_yy.dv_p")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            if account.state.rotationOwed { Banner(kind: .warning, title: L10n.t("product.keys_refused")) }
            if account.devicesError {
                Banner(kind: .danger, title: L10n.t("product.devices_error"), actionTitle: L10n.t("ios_yy.retry")) {
                    Task { await account.loadDevices() }
                }
            } else if account.devices.isEmpty {
                HStack(spacing: SATokens.Space.s2) {
                    ProgressView()
                    Text(L10n.t("product.devices_loading")).typeStyle(SATokens.TypeScale.body)
                }
            }
            ForEach(account.devices, id: \.id) { d in
                Card {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.name).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
                            Text(
                                [
                                    d.platform.capitalized,
                                    d.current ? L10n.t("ios_yy.dv_this") : nil,
                                    d.hasKey ? L10n.t("ios_yy.trusted") : L10n.t("product.device_no_key")
                                ]
                                .compactMap { $0 }.joined(separator: " · ")
                            )
                            .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                        }
                        Spacer()
                    }
                    HStack(spacing: SATokens.Space.s4) {
                        Button(L10n.t("ios_yy.rename")) {
                            newName = d.name
                            renaming = d
                        }
                        .accessibilityLabel(L10n.t("product.rename_named", ["name": d.name]))
                        if !d.current {
                            Button(L10n.t("ios_yy.revoke"), role: .destructive) { revoking = d }
                                .accessibilityLabel(L10n.t("product.revoke_named", ["name": d.name]))
                                .accessibilityIdentifier("devices.revoke")
                        }
                    }
                    .frame(minHeight: SATokens.touchTarget)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("devices.account-device")
            }
        }
        .task { await account.loadDevices() }
        .sheet(isPresented: $pairing) { PairDeviceSheet().environmentObject(account).environmentObject(model).themed() }
        .alert(L10n.t("ios_xx.rn_h"), isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(L10n.t("ios_yy.name"), text: $newName)
            Button(L10n.t("ios_yy.save")) {
                guard let d = renaming else { return }
                Task {
                    do {
                        _ = try await account.manager.renameDevice(d.id, name: newName)
                        await account.loadDevices()
                        model.toast = L10n.t("ios_yy.n_renamed")
                    } catch { model.toast = L10n.t("product.rename_failed") }
                }
            }
            Button(L10n.t("ios.cancel"), role: .cancel) {}
        }
        .alert(
            L10n.t("product.revoke_named_h", ["name": revoking?.name ?? ""]),
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })
        ) {
            Button(L10n.t("ios_xx.rv_yes"), role: .destructive) {
                guard let d = revoking else { return }
                Task {
                    do {
                        try await account.manager.revokeDevice(d.id)
                        await account.loadDevices()
                        model.toast = L10n.t(
                            account.state.keys == .ready ? "product.revoke_done" : "product.revoke_done_nokeys",
                            ["name": d.name]
                        )
                    } catch { model.toast = L10n.t("product.revoke_failed") }
                }
            }
            Button(L10n.t("ios.cancel"), role: .cancel) {}
        } message: {
            Text([L10n.t("ios_xx.rv_1"), L10n.t("ios_xx.rv_3"), L10n.t("product.revoke_files")].joined(separator: "\n"))
        }
    }
}

/// The existing device sends its key to a new one (§1.8 Pairing): paste the code the new device shows (camera
/// scanning of its QR works on real devices), check the device name, then send.
struct PairDeviceSheet: View {
    @EnvironmentObject private var account: AccountSession
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var p
    @State private var code = ""
    @State private var found: AccountKeys.CodeLookup?
    @State private var busy = false
    @State private var error: String?
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                    Text(L10n.t("product.pair_device_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                    if let found {
                        Card {
                            Text(L10n.t("product.pair_confirm", ["name": found.peer.deviceName])).typeStyle(SATokens.TypeScale.title)
                            Text(L10n.t("product.pair_confirm_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                            PrimaryButton(title: L10n.t("product.pair_send"), enabled: !busy) { send(found) }
                                .accessibilityIdentifier("pair.send")
                        }
                    } else {
                        if ScannerSupport.hasCamera {
                            if scanning {
                                QRScanner { text in
                                    scanning = false
                                    code = text
                                    lookup()
                                }
                                .aspectRatio(1, contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: SATokens.Radius.lg))
                                .accessibilityLabel(L10n.t("product.pair_scan_video"))
                            } else {
                                SecondaryButton(title: L10n.t("product.pair_scan")) { scanning = true }
                            }
                        }
                        TextField(L10n.t("product.pair_paste_label"), text: $code, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(SATokens.Space.s3)
                            .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
                            .accessibilityIdentifier("pair.code")
                        PrimaryButton(title: L10n.t("product.pair_find"), enabled: !busy && !code.isEmpty) { lookup() }
                            .accessibilityIdentifier("pair.find")
                    }
                    if let error { Banner(kind: .danger, title: error) }
                    if busy { ProgressView().frame(maxWidth: .infinity) }
                }
                .padding(SATokens.Space.s4)
            }
            .navigationTitle(L10n.t("product.pair_device"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L10n.t("ios_yy.close")) { dismiss() } } }
        }
        .screenID("pair-device")
    }

    private func lookup() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                guard let f = try await account.manager.lookupPairingCode(code) else { return error = L10n.t("product.pair_invalid") }
                found = f
            } catch {
                self.error = AccountErrors.message(error)
            }
        }
    }

    private func send(_ f: AccountKeys.CodeLookup) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await account.manager.sendKey(to: f)
                model.toast = L10n.t("product.pair_sent", ["name": f.peer.deviceName])
                dismiss()
            } catch {
                self.error = AccountErrors.message(error)
            }
        }
    }
}

/// AC-7: sign out with Keep / Clear local history; a new anonymous identity follows.
struct SignOutSheet: View {
    @EnvironmentObject private var account: AccountSession
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var p
    @State private var clear = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(footer: Text(L10n.t("product.signout_p_device"))) {
                    Picker(L10n.t("product.signout_history_device"), selection: $clear) {
                        Text(L10n.t("product.signout_keep")).tag(false)
                        Text(L10n.t("product.signout_clear")).tag(true)
                    }
                    .pickerStyle(.inline)
                    .accessibilityIdentifier("signout.history")
                }
                if let error { Section { Text(error).foregroundStyle(p.dangerInk) } }
                Section {
                    Button(L10n.t("ios_yy.s_signout"), role: .destructive) {
                        busy = true
                        Task {
                            defer { busy = false }
                            do {
                                try await account.manager.signOut(clearHistory: clear)
                                dismiss()
                            } catch { self.error = L10n.t("product.signout_failed") }
                        }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("signout.confirm")
                }
            }
            .navigationTitle(L10n.t("product.signout_h_device"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L10n.t("ios.cancel")) { dismiss() } } }
        }
        .screenID("signout")
    }
}
