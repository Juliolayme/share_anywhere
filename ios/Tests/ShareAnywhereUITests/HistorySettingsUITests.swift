import XCTest

/// HI-1/HI-2 and ST-1 on iOS: local History persists across relaunch, filters and detail work, deleting is remembered;
/// Settings changes the language and keeps "Keep screen on during transfers" (default on).
final class HistorySettingsUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testLocalHistoryShowsFiltersOpensDetailAndSurvivesRelaunch() {
        let app = UITest.app(extra: ["-seedHistory"])
        app.launch()
        UITest.skipWelcome(app)
        XCTAssertTrue(UITest.id(app, "home.see-all").waitForExistence(timeout: 10), "recent transfers on Transfer home")
        UITest.tab(app, "History")
        XCTAssertTrue(UITest.id(app, "history.local").waitForExistence(timeout: 5), "stored only on this iPhone")
        let received = UITest.id(app, "history.row.rx:ui-1")
        let failed = UITest.id(app, "history.row.tx:ui-2")
        XCTAssertTrue(received.waitForExistence(timeout: 5) && failed.exists)
        shot(app, "history")

        UITest.id(app, "history.chip.Failed").tap()
        XCTAssertTrue(failed.waitForExistence(timeout: 3))
        XCTAssertFalse(received.exists)
        UITest.id(app, "history.chip.All").tap()

        received.tap()
        XCTAssertTrue(UITest.id(app, "history-detail").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["holiday-photos.zip"].exists)
        shot(app, "history-detail")
        app.buttons["Close"].tap()

        // Relaunch without reset or seeding: the entries are still there.
        app.terminate()
        let again = UITest.app(reset: false)
        again.launch()
        UITest.tab(again, "History")
        XCTAssertTrue(UITest.id(again, "history.row.rx:ui-1").waitForExistence(timeout: 10))

        // Delete one from its detail sheet.
        UITest.id(again, "history.row.tx:ui-2").tap()
        UITest.id(again, "history-detail.delete").tap()
        XCTAssertTrue(UITest.id(again, "history.row.tx:ui-2").waitForNonExistence(timeout: 5))
    }

    func testSettingsSwitchLanguageAndKeepTheScreenOnSetting() {
        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        UITest.tab(app, "Settings")
        XCTAssertTrue(UITest.id(app, "settings").waitForExistence(timeout: 5))
        let wake = UITest.id(app, "settings.keep-screen-on")
        XCTAssertTrue(wake.waitForExistence(timeout: 5))
        XCTAssertEqual(wake.value as? String, "1", "Keep screen on is on by default")
        shot(app, "settings")
        wake.tap()
        XCTAssertEqual(wake.value as? String, "0")

        UITest.id(app, "settings.language").tap()
        app.buttons["Tiếng Việt"].tap()
        XCTAssertTrue(app.tabBars.buttons["Lịch sử"].waitForExistence(timeout: 5), "tab labels follow the language")

        app.terminate()
        let again = UITest.app(reset: false)
        again.launch()
        again.tabBars.buttons.element(boundBy: 3).tap()
        XCTAssertEqual(UITest.id(again, "settings.keep-screen-on").value as? String, "0", "the setting persists")
    }
}

extension XCUIElement {
    func waitForNonExistence(timeout: TimeInterval) -> Bool {
        let p = NSPredicate(format: "exists == false")
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: self)], timeout: timeout) == .completed
    }
}
