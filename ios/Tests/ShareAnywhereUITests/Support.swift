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

    /// Sets a switch: taps its trailing edge (a tap in the middle of a Form row only selects it) until the value is
    /// `on`, retrying while a tab or sheet transition swallows the first tap.
    static func flip(_ app: XCUIApplication, _ identifier: String, to on: Bool, file: StaticString = #filePath, line: UInt = #line) {
        let toggle = app.switches.matching(identifier: identifier).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "switch \(identifier)", file: file, line: line)
        let want = on ? "1" : "0"
        reveal(app, toggle)
        for _ in 0 ..< 4 where toggle.value as? String != want {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            _ = XCTWaiter().wait(
                for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", want), object: toggle)],
                timeout: 2
            )
        }
        XCTAssertEqual(toggle.value as? String, want, "switch \(identifier)", file: file, line: line)
    }

    /// Scrolls until `element` lies inside the window above the tab bar (coordinate taps do not scroll, and XCUITest's
    /// own scroll-to-visible fails next to iOS's secure Paste control).
    static func reveal(_ app: XCUIApplication, _ element: XCUIElement) {
        let window = app.windows.firstMatch.frame
        let visible = CGRect(x: window.minX, y: window.minY + 44, width: window.width, height: window.height - 44 - 100)
        for _ in 0 ..< 5 where !visible.contains(element.frame) {
            if element.frame.minY < visible.minY { app.swipeDown() } else { app.swipeUp() }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
    }

    /// Taps `element` where it is drawn, after revealing it.
    static func tapRevealed(_ app: XCUIApplication, _ element: XCUIElement) {
        reveal(app, element)
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    /// Waits for `element`; on a timeout prints the app's accessibility tree into the test log (the CI job log is the
    /// only place a failure can be read without the result bundle) and fails with `message`.
    @discardableResult
    static func expect(
        _ app: XCUIApplication, _ element: XCUIElement, timeout: TimeInterval, _ message: String,
        file: StaticString = #filePath, line: UInt = #line
    ) -> Bool {
        if element.waitForExistence(timeout: timeout) { return true }
        print("SA-UI-TREE begin: \(message)\n\(app.debugDescription)\nSA-UI-TREE end")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.count > 0 { print("SA-UI-TREE springboard alerts:\n\(springboard.alerts.debugDescription)") }
        XCTFail(message, file: file, line: line)
        return false
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
