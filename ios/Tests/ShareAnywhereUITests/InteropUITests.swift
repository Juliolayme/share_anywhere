import XCTest

/// iOS ↔ Web interop (nightly `ios-web-interop`, scripts/ios-interop.sh, docs/TESTING_AND_CI.md §2.4): a 64 MB file
/// each way between the app on the simulator and the Web app in Playwright Chromium, with SHA-256 checks on both ends.
/// The script passes values through `TEST_RUNNER_INTEROP_*` (Web → iOS) and the "SA-INTEROP" line this test prints
/// (iOS → Web). `testExchangesClipboardItemsWithTheWeb` is the iOS half of clipboard-cross-client
/// (scripts/ios-clipboard-interop.sh). The ios-simulator job leaves this class out (`-skip-testing`); only the interop
/// job runs it.
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

    /// Encrypted Clipboard Sync with the Web (docs/CLIPBOARD_PROTOCOL.md): the Web created the account, its key and an
    /// item; the app signs in, adds itself, prints its pairing code for the Web, decrypts the Web's item, and syncs one
    /// of its own, which the Web decrypts.
    func testExchangesClipboardItemsWithTheWeb() throws {
        let email = try XCTUnwrap(env["INTEROP_EMAIL"])
        let password = try XCTUnwrap(env["INTEROP_PASSWORD"])
        let webMarker = try XCTUnwrap(env["INTEROP_WEB_MARKER"])
        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        UITest.tab(app, "Settings")
        UITest.id(app, "settings.signin").tap()
        let field = UITest.id(app, "signin.email")
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText(email)
        let pw = UITest.id(app, "signin.password")
        pw.tap()
        pw.typeText(password)
        UITest.id(app, "signin.submit").tap()
        XCTAssertTrue(UITest.id(app, "trust").waitForExistence(timeout: 30))
        UITest.id(app, "trust.continue").tap()
        let code = UITest.id(app, "key-pair.code")
        // On a timeout the printed tree shows where the account sheet stopped (seen once: Continue still busy).
        guard UITest.expect(app, code, timeout: 60, "the pairing code for the Web") else { return }
        // scripts/ios-clipboard-interop.sh hands this to the Web, which sends its key.
        print("SA-CLIP pair=\(code.value as? String ?? "")")
        XCTAssertTrue(UITest.id(app, "checklist").waitForExistence(timeout: 5 * 60), "the Web's key arrived and verified")
        UITest.id(app, "checklist.clipboard").tap()
        XCTAssertTrue(UITest.id(app, "checklist").gone(timeout: 10), "Go to Clipboard closes the account sheet")
        XCTAssertFalse(UITest.id(app, "key-setup").exists || UITest.id(app, "key-pair").exists, "no account screen is left over Clipboard")
        let webRow = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", webMarker)).firstMatch
        XCTAssertTrue(webRow.waitForExistence(timeout: 120), "the Web's item decrypts on iOS")
        let mine = "from-ios-\(Int(Date().timeIntervalSince1970))"
        UIPasteboard.general.string = mine
        XCTAssertTrue(app.buttons["Paste"].firstMatch.waitForExistence(timeout: 10), "iOS's Paste control is shown")
        // XCUITest cannot operate the secure Paste control; the fallback read syncs (iOS asks to allow the paste).
        UITest.tapRevealed(app, UITest.id(app, "clipboard.sync-fallback"))
        UITest.allowPaste(app)
        let myRow = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", mine)).firstMatch
        UITest.expect(app, myRow, timeout: 60, "the pasted item is in the timeline")
        print("SA-CLIP marker=\(mine)")
        shot(app, "interop-clipboard")
        // Give the Web time to read it before the app goes away.
        RunLoop.current.run(until: Date().addingTimeInterval(20))
    }
}
