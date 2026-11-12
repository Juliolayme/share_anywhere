import XCTest

/// Guest-first start on iOS (PRD §2, docs/UX_SCREEN_MAP.md §2): Welcome once as a full-screen cover, then Transfer;
/// no sign-in anywhere on the way; the anonymous identity is created in the background against the real backend.
final class GuestLaunchUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testFreshInstallGoesFromWelcomeToTransferWithoutSignIn() {
        let app = UITest.app()
        app.launch()
        XCTAssertTrue(UITest.id(app, "welcome").waitForExistence(timeout: 15))
        shot(app, "welcome")
        XCTAssertFalse(app.buttons["Sign In"].exists, "Welcome offers no sign-in gate")
        UITest.id(app, "welcome.start").tap()
        XCTAssertTrue(UITest.id(app, "home").waitForExistence(timeout: 10))
        XCTAssertFalse(UITest.id(app, "signin").exists)
        XCTAssertTrue(UITest.id(app, "home.guest").exists)
        XCTAssertFalse(app.tabBars.buttons["Clipboard"].exists, "Clipboard stays hidden until milestone 7.4")
        shot(app, "home")

        // Later launches start on Transfer directly.
        app.terminate()
        let again = UITest.app(reset: false)
        again.launch()
        XCTAssertTrue(UITest.id(again, "home").waitForExistence(timeout: 10))
        XCTAssertFalse(UITest.id(again, "welcome").exists)
    }

    func testTheAnonymousIdentityIsCreatedAndCanBeRenamed() {
        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        UITest.tab(app, "Devices")
        let name = UITest.id(app, "devices.name")
        XCTAssertTrue(name.waitForExistence(timeout: 30), "the device identity comes from the backend")
        shot(app, "devices")
        UITest.id(app, "devices.rename").tap()
        let field = UITest.id(app, "rename.field")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        // Put the cursor at the end, delete the current name, type the new one.
        let current = field.value as? String ?? ""
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
        field.typeText("Kitchen iPhone")
        UITest.id(app, "rename.save").tap()
        XCTAssertTrue(app.staticTexts["Kitchen iPhone"].waitForExistence(timeout: 15))
    }
}
