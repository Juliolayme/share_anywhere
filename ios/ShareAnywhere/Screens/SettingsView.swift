import SAStore
import SwiftUI
import UserNotifications

/// ST-1 Settings (design `settings`), guest: header "Guest", device name, appearance, language, keep screen on,
/// notifications, local history retention and Clear history, privacy, about. Account rows arrive with accounts (7.4).
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore
    @Environment(\.palette) private var p
    @State private var renaming = false
    @State private var confirmClear = false
    @State private var notifStatus: UNAuthorizationStatus?

    var body: some View {
        Form {
            Section {
                HStack(spacing: SATokens.Space.s3) {
                    Image(systemName: "person.crop.circle").font(.system(size: 36)).foregroundStyle(p.fg3).accessibilityHidden(true)
                    VStack(alignment: .leading) {
                        Text(L10n.t("ios_yy.s_guest")).typeStyle(SATokens.TypeScale.labelLg)
                        Text(L10n.t("ios_vv.k144")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    }
                }
                .accessibilityIdentifier("settings.guest")
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
        .confirmationDialog(L10n.t("ios_yy.hc_h"), isPresented: $confirmClear, titleVisibility: .visible) {
            Button(L10n.t("ios_yy.cb_clear"), role: .destructive) { Task { await model.clearHistory() } }
        } message: {
            Text(L10n.t("ios_yy.hc_p"))
        }
        .task { await refreshNotifications() }
        .screenID("settings")
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
