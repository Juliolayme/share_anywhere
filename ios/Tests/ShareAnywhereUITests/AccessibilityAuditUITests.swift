import XCTest

/// Accessibility audit (docs/phases/PHASE_9_HARDENING_RELEASE.md): XCTest's `performAccessibilityAudit()` (the checks of
/// Xcode's Accessibility Inspector: element descriptions, hit regions, contrast, Dynamic Type, clipped text, traits)
/// on every main screen. Every issue fails the test; each one is recorded with the element it names, so the failure
/// message lists what to fix. VoiceOver use itself is on the real-device checklist.
final class AccessibilityAuditUITests: XCTestCase {
    override func setUp() { continueAfterFailure = true }

    private func audit(_ app: XCUIApplication, _ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        guard #available(iOS 17.0, *) else { return }
        do {
            try app.performAccessibilityAudit { issue in
                let element = issue.element.map { "\($0.elementType) '\($0.identifier)' '\($0.label)'" } ?? "screen"
                XCTFail("\(screen): \(issue.compactDescription) — \(element): \(issue.detailedDescription)", file: file, line: line)
                return true // reported here; do not fail twice
            }
        } catch {
            XCTFail("\(screen): audit could not run: \(error)", file: file, line: line)
        }
    }

    func testEveryMainScreenPassesTheAccessibilityAudit() throws {
        let app = UITest.app(extra: ["-seedHistory", "-seedSendFiles", "2", "-seedFileBytes", "2000000"])
        app.launch()
        XCTAssertTrue(UITest.id(app, "welcome").waitForExistence(timeout: 15))
        audit(app, "welcome")
        UITest.id(app, "welcome.start").tap()
        XCTAssertTrue(UITest.id(app, "home.send").waitForExistence(timeout: 15))
        audit(app, "home")

        UITest.id(app, "home.send").tap()
        XCTAssertTrue(UITest.id(app, "send.total").waitForExistence(timeout: 15))
        audit(app, "send")
        UITest.id(app, "send.create").tap()
        XCTAssertTrue(UITest.id(app, "session-code").waitForExistence(timeout: 30))
        audit(app, "session")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        UITest.tab(app, "Transfer")
        if !UITest.id(app, "home.receive").waitForExistence(timeout: 5) { UITest.tab(app, "Transfer") }
        UITest.id(app, "home.receive").tap()
        XCTAssertTrue(UITest.id(app, "receive-code").waitForExistence(timeout: 10))
        audit(app, "receive-code")

        for (tab, screen) in [
            ("Clipboard", "clipboard.intro"),
            ("History", "history.row.rx:ui-1"),
            ("Devices", "devices.name"),
            ("Settings", "settings")
        ] {
            UITest.tab(app, tab)
            XCTAssertTrue(UITest.id(app, screen).waitForExistence(timeout: 30), tab)
            audit(app, tab.lowercased())
        }
        UITest.id(app, "settings.signin").tap()
        XCTAssertTrue(UITest.id(app, "signin").waitForExistence(timeout: 10))
        audit(app, "signin")
    }
}
