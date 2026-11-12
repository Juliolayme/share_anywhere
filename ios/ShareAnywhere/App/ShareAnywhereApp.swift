import SwiftUI

@main
struct ShareAnywhereApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.settings)
        }
    }
}

/// Tabs with a NavigationStack each (docs/UX_SCREEN_MAP.md §11); Welcome as a full-screen cover on first launch only.
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore

    var body: some View {
        TabView(selection: $model.tab) {
            NavigationStack { HomeView() }
                .tabItem { Label(L10n.t("ios.home"), systemImage: "arrow.up.arrow.down.circle") }
                .tag(AppModel.Tab.home)
            NavigationStack { HistoryView() }
                .tabItem { Label(L10n.t("ios.hist"), systemImage: "clock.arrow.circlepath") }
                .tag(AppModel.Tab.history)
            NavigationStack { DevicesView() }
                .tabItem { Label(L10n.t("ios.dev"), systemImage: "laptopcomputer.and.iphone") }
                .tag(AppModel.Tab.devices)
            NavigationStack { SettingsView() }
                .tabItem { Label(L10n.t("ios.set"), systemImage: "gearshape") }
                .tag(AppModel.Tab.settings)
        }
        .themed()
        .preferredColorScheme(settings.colorScheme)
        .id(settings.language) // re-render every string when the language changes
        .fullScreenCover(isPresented: Binding(get: { !settings.welcomed }, set: { if !$0 { settings.welcomed = true } })) {
            WelcomeView { settings.welcomed = true }.themed()
        }
        .overlay(alignment: .bottom) { ToastView() }
    }
}

/// A short confirmation at the bottom (announced to VoiceOver), dismissed after a few seconds.
struct ToastView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p

    var body: some View {
        if let text = model.toast {
            Text(text)
                .typeStyle(SATokens.TypeScale.body)
                .foregroundStyle(p.toastFg)
                .padding(.horizontal, SATokens.Space.s4)
                .padding(.vertical, SATokens.Space.s3)
                .background(p.toast, in: Capsule())
                .padding(.bottom, 64)
                .accessibilityIdentifier("toast")
                .task(id: text) {
                    UIAccessibility.post(notification: .announcement, argument: text)
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if model.toast == text { model.toast = nil }
                }
        }
    }
}
