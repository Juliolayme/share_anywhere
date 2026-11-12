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
        for _ in 0 ..< 4 where toggle.value as? String != want {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            _ = XCTWaiter().wait(
                for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", want), object: toggle)],
                timeout: 2
            )
        }
        XCTAssertEqual(toggle.value as? String, want, "switch \(identifier)", file: file, line: line)
    }

    /// iOS's Paste control is a secure system control: XCUITest cannot run its scroll-to-visible accessibility action on
    /// it, so it is tapped where it is drawn once it settles on screen.
    static func tapPasteControl(_ control: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(10)
        var last = CGRect.null
        while Date() < deadline {
            let f = control.frame
            if !f.isEmpty, f == last { break }
            last = f
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        XCTAssertFalse(control.frame.isEmpty, "the Paste control is on screen", file: file, line: line)
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
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
