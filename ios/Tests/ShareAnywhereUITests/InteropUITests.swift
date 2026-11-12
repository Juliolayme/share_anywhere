import XCTest

/// iOS ↔ Web interop (nightly `ios-web-interop`, scripts/ios-interop.sh, docs/TESTING_AND_CI.md §2.4): a 64 MB file
/// each way between the app on the simulator and the Web app in Playwright Chromium, with SHA-256 checks on both ends.
/// The script passes values through `TEST_RUNNER_INTEROP_*` (Web → iOS) and the "SA-INTEROP" line this test prints
/// (iOS → Web). The ios-simulator job leaves this class out (`-skip-testing`); only the interop job runs it.
final class InteropUITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    override func setUp() { continueAfterFailure = false }

    func testReceivesFromTheWeb() throws {
        let code = try XCTUnwrap(env["INTEROP_CODE"], "INTEROP_CODE from the Web sender")
        let sha = try XCTUnwrap(env["INTEROP_SHA256"])
        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        UITest.id(app, "home.receive").tap()
        let field = UITest.id(app, "receive.code-input")
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText(code)
        UITest.id(app, "receive.continue").tap()
        XCTAssertTrue(UITest.id(app, "preview.receive").waitForExistence(timeout: 30))
        UITest.id(app, "preview.receive").tap()
        XCTAssertTrue(UITest.id(app, "rx.start").waitForExistence(timeout: 30))
        UITest.id(app, "rx.start").tap()
        XCTAssertTrue(UITest.id(app, "rx-done").waitForExistence(timeout: 14 * 60), "the Web's file arrives")
        shot(app, "interop-rx-done")
        let hashes = UITest.id(app, "test.rx-sha256")
        eventually("hash computed", timeout: 120) { (hashes.value as? String)?.isEmpty == false }
        let value = hashes.value as? String ?? ""
        XCTAssertTrue(value.hasSuffix("=\(sha)"), "SHA-256 matches the Web's fixture: \(value)")
        XCTAssertTrue(UITest.id(app, "rx.result").exists)
    }

    func testSendsToTheWeb() {
        let size = 64 * 1024 * 1024
        let app = UITest.app(extra: ["-seedSendFiles", "1", "-seedFileBytes", "\(size)"])
        app.launch()
        UITest.skipWelcome(app)
        UITest.id(app, "home.send").tap()
        XCTAssertTrue(UITest.id(app, "send.total").waitForExistence(timeout: 60))
        UITest.id(app, "send.create").tap()
        let codeEl = UITest.id(app, "session-code")
        XCTAssertTrue(codeEl.waitForExistence(timeout: 30))
        let code = codeEl.value as? String ?? ""
        let sha = TestPeer.sha256(TestPeer.seededContent(index: 0, size: size))
        // scripts/ios-interop.sh reads this line from the xcodebuild output and starts the Playwright receiver.
        print("SA-INTEROP code=\(code) sha256=\(sha) name=sa-seed-1.bin")
        XCTAssertTrue(UITest.id(app, "dashboard-done").waitForExistence(timeout: 14 * 60), "the Web receiver got the file")
        shot(app, "interop-dashboard-done")
    }
}
