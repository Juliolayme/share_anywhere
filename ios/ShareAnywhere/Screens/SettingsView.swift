import SAAccount
import SAStore
import SwiftUI
import UserNotifications

/// ST-1 Settings (design `settings`): the Guest header with Sign in, or the account (email, Add this device, history
/// sync, Clipboard Sync settings, Sign out); device name, appearance, language, keep screen on, notifications, local
/// history retention and Clear history, privacy, about. File sharing never needs the account rows.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var accountSheet: AccountSheet.Step?
    @State private var signingOut = false
    @State private var renaming = false
    @State private var confirmClear = false
    @State private var notifStatus: UNAuthorizationStatus?

    var body: some View {
        Form {
            Section {
                if account.state.signedIn {
                    HStack(spacing: SATokens.Space.s3) {
                        Image(systemName: "person.crop.circle.fill").font(.system(size: 36)).foregroundStyle(p.send)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading) {
                            Text(account.state.email ?? "—").typeStyle(SATokens.TypeScale.labelLg)
                            Text(L10n.t(account.state.added ? "ios_yy.trusted" : "product.add_device_off_p_device"))
                                .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("settings.account")
                } else {
                    HStack(spacing: SATokens.Space.s3) {
                        Image(systemName: "person.crop.circle").font(.system(size: 36)).foregroundStyle(p.fg3).accessibilityHidden(true)
                        VStack(alignment: .leading) {
                            Text(L10n.t("ios_yy.s_guest")).typeStyle(SATokens.TypeScale.labelLg)
                            Text(L10n.t("ios_vv.k144")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                        }
                        Spacer()
                        if model.config.accounts {
                            Button(L10n.t("ios_yy.signin")) { accountSheet = .signIn }.accessibilityIdentifier("settings.signin")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("settings.guest")
                }
                Button { renaming = true } label: {
                    HStack {
                        Text(L10n.t("ios_yy.name")).foregroundStyle(p.fg)
                        Spacer()
                        Text(model.identityState.device?.displayName ?? "—").foregroundStyle(p.fg2)
                    }
                }
                .disabled(model.identityState.device == nil)
                .accessibilityIdentifier("settings.device-name")
            }
            Section(L10n.t("ios_yy.g_app")) {
                Picker(L10n.t("ios_yy.s_theme"), selection: $settings.theme) {
                    Text(L10n.t("ios_yy.th_sys")).tag(SettingsStore.Theme.system)
                    Text(L10n.t("ios_yy.th_light")).tag(SettingsStore.Theme.light)
                    Text(L10n.t("ios_yy.th_dark")).tag(SettingsStore.Theme.dark)
                }
                .accessibilityIdentifier("settings.theme")
                Picker(L10n.t("ios_yy.s_lang"), selection: $settings.language) {
                    Text(L10n.t("ios_yy.th_sys")).tag(SettingsStore.Language.system)
                    Text(L10n.t("product.lang_en")).tag(SettingsStore.Language.en)
                    Text(L10n.t("product.lang_vi")).tag(SettingsStore.Language.vi)
                }
                .accessibilityIdentifier("settings.language")
            }
            Section(footer: Text(L10n.t("ios_yy.s_wake_p"))) {
                Toggle(L10n.t("ios_yy.s_wake"), isOn: $settings.keepScreenOn).accessibilityIdentifier("settings.keep-screen-on")
                notificationsRow
            }
            Section(header: Text(L10n.t("ios_yy.g_priv")), footer: Text(L10n.t("ios_yy.s_priv_p"))) {
                Picker(L10n.t("ios_yy.s_histkeep"), selection: Binding(get: { settings.retention }, set: { model.setRetention($0) })) {
                    Text(L10n.t("ios_yy.h30")).tag(Retention.days30)
                    Text(L10n.t("ios_yy.h90")).tag(Retention.days90)
                    Text(L10n.t("ios_yy.h0")).tag(Retention.none)
                }
                .accessibilityIdentifier("settings.retention")
                Button(L10n.t("ios_yy.cb_clear"), role: .destructive) { confirmClear = true }
                    .disabled(model.historyEntries.isEmpty)
                    .accessibilityIdentifier("settings.clear-history")
            }
            CloudSettingsSection(signedIn: account.state.signedIn)
            if account.state.signedIn { accountSections }
            Section(L10n.t("ios_yy.g_about")) {
                HStack {
                    Text(L10n.t("ios_yy.s_version"))
                    Spacer()
                    Text(L10n.t("product.version_ios", ["version": model.config.version])).foregroundStyle(p.fg2)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings.version")
            }
        }
        .navigationTitle(L10n.t("ios.set"))
        .sheet(isPresented: $renaming) { RenameSheet(current: model.identityState.device?.displayName ?? "").themed() }
        .sheet(item: Binding(get: { accountSheet.map(AccountSheetItem.init) }, set: { accountSheet = $0?.step })) { item in
            AccountSheet(start: item.step).environmentObject(account).environmentObject(model)
        }
        .sheet(isPresented: $signingOut) { SignOutSheet().environmentObject(account).environmentObject(model).themed() }
        .confirmationDialog(L10n.t("ios_yy.hc_h"), isPresented: $confirmClear, titleVisibility: .visible) {
            Button(L10n.t("ios_yy.cb_clear"), role: .destructive) { Task { await model.clearHistory() } }
        } message: {
            Text(L10n.t("ios_yy.hc_p"))
        }
        .task { await refreshNotifications() }
        .screenID("settings")
    }

    /// Account, history sync and Clipboard Sync settings (signed in).
    @ViewBuilder private var accountSections: some View {
        Section(header: Text(L10n.t("ios_yy.g_account")), footer: Text(L10n.t("product.history_sync_p"))) {
            if !account.state.added {
                Button(L10n.t("product.add_device_btn")) { accountSheet = .trust }.accessibilityIdentifier("settings.add-device")
            } else if account.state.keys == .setup || account.state.keys == .pair {
                Button(L10n.t(account.state.keys == .setup ? "product.key_setup_cta" : "product.pair_h")) {
                    accountSheet = account.state.keys == .setup ? .keySetup : .keyPair
                }
                .accessibilityIdentifier("settings.keys")
            }
            Toggle(L10n.t("product.history_sync"), isOn: Binding(get: { account.state.historySync }, set: { on in
                Task {
                    do { try await account.manager.setHistorySync(on) } catch { model.toast = L10n.t("product.history_sync_failed_toggle") }
                }
            }))
            .disabled(!account.state.added || account.state.keys != .ready)
            .accessibilityIdentifier("settings.history-sync")
            Button(L10n.t("ios_yy.s_signout"), role: .destructive) { signingOut = true }.accessibilityIdentifier("settings.signout")
        }
        if let cb = account.clip.settings {
            Section(header: Text(L10n.t("ios_yy.g_clip")), footer: Text(L10n.t("product.cb_skip_disclaimer"))) {
                Toggle(L10n.t("product.cb_pause_label"), isOn: Binding(get: { cb.paused }, set: { v in saveClip { $0.paused = v } }))
                    .accessibilityIdentifier("settings.cb-pause")
                Toggle(L10n.t("ios_yy.s_skip"), isOn: Binding(get: { cb.sensitiveSkip }, set: { v in saveClip { $0.sensitiveSkip = v } }))
                    .accessibilityIdentifier("settings.cb-skip")
                Picker(
                    L10n.t("ios_yy.s_clipkeep"),
                    selection: Binding(get: { cb.retentionDays }, set: { v in saveClip { $0.retentionDays = v } })
                ) {
                    Text(L10n.t("product.cb_keep_1")).tag(1)
                    Text(L10n.t("product.cb_keep_days", ["n": "7"])).tag(7)
                }
            }
        }
    }

    private func saveClip(_ change: (inout ClipboardSettings) -> Void) {
        guard var s = account.clip.settings else { return }
        change(&s)
        let next = s
        Task {
            do { try await account.saveClipboardSettings(next) } catch { model.toast = L10n.t("product.cb_settings_failed") }
        }
    }

    /// Notifications: the system permission state with Allow (asked here, just in time) or a way to System Settings.
    @ViewBuilder private var notificationsRow: some View {
        HStack {
            Text(L10n.t("ios_yy.s_notif"))
            Spacer()
            switch notifStatus {
            case .authorized?, .provisional?, .ephemeral?:
                Text(L10n.t("ios_yy.on")).foregroundStyle(p.fg2)
            case .denied?:
                Button(L10n.t("ios_yy.nt_on")) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            case .notDetermined?:
                Button(L10n.t("ios_yy.an_allow")) {
                    Task {
                        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                        await refreshNotifications()
                    }
                }
            default:
                ProgressView()
            }
        }
        .frame(minHeight: SATokens.touchTarget)
        .accessibilityIdentifier("settings.notifications")
    }

    private func refreshNotifications() async {
        notifStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
}

struct AccountSheetItem: Identifiable {
    let step: AccountSheet.Step
    var id: String { "\(step)" }
}
