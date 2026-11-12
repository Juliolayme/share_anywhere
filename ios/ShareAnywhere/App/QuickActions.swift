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
        Task { @MainActor in _ = QuickActions.shared.handle(item) }
    }

    func windowScene(
        _: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in completionHandler(QuickActions.shared.handle(shortcutItem)) }
    }
}
