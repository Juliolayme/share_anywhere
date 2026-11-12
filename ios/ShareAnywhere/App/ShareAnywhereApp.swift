import SwiftUI

@main
struct ShareAnywhereApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.settings)
                .environmentObject(model.keepAwake)
                .environmentObject(model.hub)
                .environmentObject(model.account)
                .environmentObject(model.pasteboard)
        }
    }
}

/// Tabs with a NavigationStack each (docs/UX_SCREEN_MAP.md §11); Welcome as a full-screen cover on first launch only.
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var quick = QuickActions.shared

    var body: some View {
        TabView(selection: $model.tab) {
            NavigationStack(path: $model.homePath) {
                HomeView().navigationDestination(for: Route.self) { route in
                    switch route {
                    case .send: SendView()
                    case let .session(id): SessionScreen(id: id)
                    case .receive: ReceiveView()
                    case let .preview(id): JoinPreviewView(sessionId: id)
                    case let .receiving(id): ReceivingView(id: id)
                    }
                }
            }
            .tabItem { Label(L10n.t("ios.home"), systemImage: "arrow.up.arrow.down.circle") }
            .tag(AppModel.Tab.home)
            if model.config.clipboard {
                NavigationStack { ClipboardView() }
                    .tabItem { Label(L10n.t("ios.clip"), systemImage: "doc.on.clipboard") }
                    .tag(AppModel.Tab.clipboard)
            }
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
        .overlay(alignment: .topLeading) { if model.config.uiTesting { TestProbes() } }
        .onChange(of: scenePhase) { model.hub.scenePhase($0) }
        .onChange(of: settings.keepScreenOn) { model.keepAwake.setEnabled($0) }
        .onOpenURL { model.openLink($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { model.openLink(url) }
        }
        .onChange(of: quick.pending) { action in
            guard action == QuickActions.clipboard, model.config.clipboard else { return }
            settings.welcomed = true
            model.tab = .clipboard
            quick.pending = nil
        }
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

/// `-uiTesting` only: values tests read without touching the UI (idle timer, pasteboard reads, device id).
struct TestProbes: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var pasteboard: PasteboardAccess

    var body: some View {
        VStack(spacing: 0) {
            IdleTimerProbe()
            probe("test.pasteboard-reads", "\(pasteboard.reads)")
            probe("test.device-id", model.identityState.claims?.sub ?? "")
        }
    }

    private func probe(_ id: String, _ value: String) -> some View {
        Text(value).font(.system(size: 1)).opacity(0.02).frame(width: 1, height: 1)
            .accessibilityIdentifier(id).accessibilityValue(value)
    }
}
