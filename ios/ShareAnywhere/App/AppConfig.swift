import Foundation

/// Build and launch configuration. Feature flags follow CLAUDE.md §8b: `accounts` and `clipboard` are on since
/// milestone 7.4 made sign-in, keys and Clipboard Sync work on iOS.
struct AppConfig {
    let backendURL: URL
    let requireHTTPS: Bool
    /// `-uiTesting`: XCUITest hooks (hidden state elements, seeding) are on.
    let uiTesting: Bool
    /// `-resetState`: wipe defaults, Keychain item and database before launch (a fresh install).
    let resetState: Bool
    /// `-seedHistory`: add sample local History entries (UI tests only).
    let seedHistory: Bool
    /// The origin share links and QR codes use (`<origin>/j/<token>`); links to any other origin are refused.
    let publicURL: URL
    /// `-seedSendFiles N` (UI tests): Send starts with N generated files of `-seedFileBytes` bytes each.
    let seedSendFiles: Int
    let seedFileBytes: Int
    /// Seconds a transfer keeps going after the app leaves the screen before it pauses (`-backgroundGrace`, UI tests).
    let backgroundGrace: Double
    /// `-routeStep relay-udp|relay-tls` (UI tests): receivers dial relay-only on that ICE policy step (forced relay).
    let routeStep: String?
    /// `-insecureTurnTLS` (UI tests): accept the CI coturn's self-signed TURN TLS certificate (docs/ADR/0029).
    let insecureTurnTLS: Bool
    let accounts = true
    let clipboard = true
    let version: String

    /// Whether this process runs under UI tests (Debug only), for views that cannot reach the model.
    static var uiTestingProcess: Bool {
        #if DEBUG
            ProcessInfo.processInfo.arguments.contains("-uiTesting")
        #else
            false
        #endif
    }

    /// Debug only: the arguments of the last XCUITest launch, for a launch the system starts on its own (a link opened
    /// while the app is not running gets no launch arguments). A separate suite, so `-resetState` does not wipe it.
    private static let testLaunchKey = "lastUITestArguments"
    private static var testDefaults: UserDefaults? { UserDefaults(suiteName: "app.shareanywhere.uitest") }

    static func load(arguments launched: [String] = ProcessInfo.processInfo.arguments, bundle: Bundle = .main) -> AppConfig {
        var arguments = launched
        #if DEBUG
            if launched.contains("-uiTesting") {
                testDefaults?.set(Array(launched.dropFirst()).filter { $0 != "-resetState" }, forKey: testLaunchKey)
                testDefaults?.set(Date().timeIntervalSince1970, forKey: testLaunchKey + ".at")
            } else if let saved = testDefaults?.stringArray(forKey: testLaunchKey),
                      let at = testDefaults?.double(forKey: testLaunchKey + ".at"),
                      Date().timeIntervalSince1970 - at < 15 * 60 {
                // The system launched the test installation (cold start from a link) right after a UI test: keep its
                // test configuration. Older entries are ignored, so a later manual Debug run starts normally.
                arguments = [launched.first ?? ""] + saved
            }
        #endif
        func value(after flag: String) -> String? {
            guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
            return arguments[i + 1]
        }
        // Test hooks exist only in Debug builds: a Release build ignores every launch argument below.
        #if DEBUG
            let uiTesting = arguments.contains("-uiTesting")
        #else
            let uiTesting = false
        #endif
        let plist = (bundle.object(forInfoDictionaryKey: "SABackendURL") as? String) ?? ""
        let raw = (uiTesting ? value(after: "-backendURL") : nil) ?? plist
        let url = URL(string: raw.isEmpty ? "http://127.0.0.1:8080" : raw) ?? URL(string: "http://127.0.0.1:8080")!
        #if DEBUG
            let requireHTTPS = false
        #else
            let requireHTTPS = true
        #endif
        let publicRaw = (uiTesting ? value(after: "-publicURL") : nil) ?? (bundle.object(forInfoDictionaryKey: "SAPublicURL") as? String) ??
            ""
        let publicURL = URL(string: publicRaw).flatMap { $0.host == nil ? nil : $0 } ?? url
        let short = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return AppConfig(
            backendURL: url, requireHTTPS: requireHTTPS, uiTesting: uiTesting, resetState: uiTesting && arguments.contains("-resetState"),
            seedHistory: uiTesting && arguments.contains("-seedHistory"), publicURL: publicURL,
            seedSendFiles: uiTesting ? Int(value(after: "-seedSendFiles") ?? "") ?? 0 : 0,
            seedFileBytes: min(64 << 20, max(1, Int(value(after: "-seedFileBytes") ?? "") ?? 3_000_000)),
            backgroundGrace: uiTesting ? Double(value(after: "-backgroundGrace") ?? "") ?? 20 : 20,
            routeStep: uiTesting ? value(after: "-routeStep") : nil,
            insecureTurnTLS: uiTesting && arguments.contains("-insecureTurnTLS"),
            version: "\(short) (\(build))"
        )
    }
}
