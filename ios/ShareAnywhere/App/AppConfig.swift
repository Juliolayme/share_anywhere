import Foundation

/// Build and launch configuration. Feature flags follow CLAUDE.md §8b: `accounts` and `clipboard` stay off until the
/// iOS milestones that make them work (7.4), so no Sign in button or Clipboard screen does nothing.
struct AppConfig {
    let backendURL: URL
    let requireHTTPS: Bool
    /// `-uiTesting`: XCUITest hooks (hidden state elements, seeding) are on.
    let uiTesting: Bool
    /// `-resetState`: wipe defaults, Keychain item and database before launch (a fresh install).
    let resetState: Bool
    /// `-seedHistory`: add sample local History entries (UI tests only).
    let seedHistory: Bool
    let accounts = false
    let clipboard = false
    let version: String

    static func load(arguments: [String] = ProcessInfo.processInfo.arguments, bundle: Bundle = .main) -> AppConfig {
        func value(after flag: String) -> String? {
            guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
            return arguments[i + 1]
        }
        let uiTesting = arguments.contains("-uiTesting")
        let plist = (bundle.object(forInfoDictionaryKey: "SABackendURL") as? String) ?? ""
        let raw = (uiTesting ? value(after: "-backendURL") : nil) ?? value(after: "-backendURL") ?? plist
        let url = URL(string: raw.isEmpty ? "http://127.0.0.1:8080" : raw) ?? URL(string: "http://127.0.0.1:8080")!
        #if DEBUG
            let requireHTTPS = false
        #else
            let requireHTTPS = true
        #endif
        let short = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return AppConfig(
            backendURL: url, requireHTTPS: requireHTTPS, uiTesting: uiTesting, resetState: arguments.contains("-resetState"),
            seedHistory: uiTesting && arguments.contains("-seedHistory"), version: "\(short) (\(build))"
        )
    }
}
