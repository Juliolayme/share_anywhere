import XCTest

/// Launch helpers for XCUITest (docs/TESTING_AND_CI.md §5b): the native CI backend at BACKEND_URL (default
/// http://127.0.0.1:8080), `-uiTesting` hooks, and `-resetState` for a fresh install.
enum UITest {
    static var backendURL: String { ProcessInfo.processInfo.environment["BACKEND_URL"] ?? "http://127.0.0.1:8080" }

    /// The nightly matrix's Dynamic Type run (`TEST_RUNNER_DYNAMIC_TYPE`), e.g. accessibility XXXL.
    static var dynamicType: [String] {
        guard let size = ProcessInfo.processInfo.environment["DYNAMIC_TYPE"], !size.isEmpty else { return [] }
        return ["-UIPreferredContentSizeCategoryName", size]
    }

    static func app(reset: Bool = true, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting", "-backendURL", backendURL, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            + (reset ? ["-resetState"] : []) + dynamicType + extra
        return app
    }

    /// Element by accessibility identifier, whatever its type.
    static func id(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    static func skipWelcome(_ app: XCUIApplication) {
        let start = id(app, "welcome.start")
        if start.waitForExistence(timeout: 10) { start.tap() }
    }

    static func tab(_ app: XCUIApplication, _ label: String) {
        app.tabBars.buttons[label].tap()
    }
}

extension XCTestCase {
    /// A screenshot attached to the result bundle (kept for the phase report).
    func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
