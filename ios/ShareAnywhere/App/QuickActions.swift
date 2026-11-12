import SwiftUI
import UIKit

/// The Home Screen quick action that opens the Clipboard tab (`UIApplicationShortcutItems` in Info.plist). The scene
/// delegate hands it over at launch and while running; the root view switches tabs.
@MainActor
final class QuickActions: ObservableObject {
    static let shared = QuickActions()
    static let clipboard = "app.shareanywhere.clipboard"
    @Published var pending: String?

    func handle(_ item: UIApplicationShortcutItem?) -> Bool {
        guard let item, item.type == QuickActions.clipboard else { return false }
        pending = item.type
        return true
    }
}

/// Share links (`shareanywhere://j/…` in tests, Universal Links on devices). With a custom scene delegate the URL can
/// reach either the delegate or SwiftUI's `onOpenURL`, so both feed this inbox and a repeat within a moment is dropped.
@MainActor
final class LinkInbox: ObservableObject {
    static let shared = LinkInbox()
    @Published var pending: URL?
    private var last: (url: URL, at: Date)?

    func receive(_ url: URL?) {
        guard let url else { return }
        if let last, last.url == url, Date().timeIntervalSince(last.at) < 2 { return }
        last = (url, Date())
        pending = url
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _: UIApplication, configurationForConnecting session: UISceneSession, options _: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_: UIScene, willConnectTo _: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        let item = connectionOptions.shortcutItem
        let url = connectionOptions.urlContexts.first?.url
        let web = connectionOptions.userActivities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }?.webpageURL
        Task { @MainActor in
            _ = QuickActions.shared.handle(item)
            LinkInbox.shared.receive(url ?? web)
        }
    }

    func scene(_: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        let url = contexts.first?.url
        Task { @MainActor in LinkInbox.shared.receive(url) }
    }

    func scene(_: UIScene, continue activity: NSUserActivity) {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb else { return }
        let url = activity.webpageURL
        Task { @MainActor in LinkInbox.shared.receive(url) }
    }

    func windowScene(
        _: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in completionHandler(QuickActions.shared.handle(shortcutItem)) }
    }
}
