import XCTest

/// Screenshots of the main screens for the phase report (docs/phases/PHASE_7_IOS.md deliverables), in light and dark
/// appearance (`-theme`, read by SettingsStore from the launch arguments). The nightly `ios-matrix` runs the same tests
/// on more devices and with accessibility XXXL Dynamic Type. Each step also asserts that the screen rendered.
final class ScreenshotUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func walk(theme: String) {
        let app = UITest.app(extra: ["-theme", theme, "-seedHistory", "-seedSendFiles", "2", "-seedFileBytes", "2000000"])
        app.launch()
        XCTAssertTrue(UITest.id(app, "welcome").waitForExistence(timeout: 15))
        shot(app, "\(theme)-welcome")
        UITest.id(app, "welcome.start").tap()
        XCTAssertTrue(UITest.id(app, "home.send").waitForExistence(timeout: 15))
        shot(app, "\(theme)-home")

        UITest.id(app, "home.send").tap()
        XCTAssertTrue(UITest.id(app, "send.total").waitForExistence(timeout: 15))
        shot(app, "\(theme)-send")
        UITest.id(app, "send.create").tap()
        XCTAssertTrue(UITest.id(app, "session-code").waitForExistence(timeout: 30))
        shot(app, "\(theme)-session")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        UITest.tab(app, "Transfer")
        if !UITest.id(app, "home.receive").waitForExistence(timeout: 5) { UITest.tab(app, "Transfer") }
        UITest.id(app, "home.receive").tap()
        XCTAssertTrue(UITest.id(app, "receive-code").waitForExistence(timeout: 10))
        shot(app, "\(theme)-receive-code")

        UITest.tab(app, "Clipboard")
        XCTAssertTrue(UITest.id(app, "clipboard.intro").waitForExistence(timeout: 10))
        shot(app, "\(theme)-clipboard-guest")
        UITest.tab(app, "History")
        XCTAssertTrue(UITest.id(app, "history.row.rx:ui-1").waitForExistence(timeout: 10))
        shot(app, "\(theme)-history")
        UITest.tab(app, "Devices")
        XCTAssertTrue(UITest.id(app, "devices.name").waitForExistence(timeout: 30))
        shot(app, "\(theme)-devices")
        UITest.tab(app, "Settings")
        XCTAssertTrue(UITest.id(app, "settings").waitForExistence(timeout: 10))
        shot(app, "\(theme)-settings")
        UITest.id(app, "settings.signin").tap()
        XCTAssertTrue(UITest.id(app, "signin").waitForExistence(timeout: 10))
        shot(app, "\(theme)-signin")
    }

    func testLightScreens() { walk(theme: "light") }

    func testDarkScreens() { walk(theme: "dark") }
}
