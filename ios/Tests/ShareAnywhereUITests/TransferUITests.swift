import SATransferRuntime
import XCTest

/// Guest send and receive on the simulator (docs/phases/PHASE_7_IOS.md, PRD §2 and §5): no sign-in anywhere, open
/// join by code, the join window expiring (backend test clock) with Create new code while a joined receiver stays,
/// Remove and Block, Require approval, keep screen on (`isIdleTimerDisabled` through the `-uiTesting` probe), local
/// History after relaunch, and a transfer paused by leaving the app and resumed on return. The other device is a
/// `TestPeer` in the test runner over real WebRTC.
final class TransferUITests: XCTestCase {
    var peers: [TestPeer] = []

    override func setUp() { continueAfterFailure = false }

    override func tearDown() {
        let all = peers
        peers.removeAll()
        _ = try? blocking(60) {
            for p in all {
                await p.dispose()
            }
        }
    }

    private func peer(_ name: String) throws -> TestPeer {
        let p = try TestPeer()
        try blocking(90) { try await p.ready(name: name) }
        peers.append(p)
        return p
    }

    private func idle(_ app: XCUIApplication) -> String? { UITest.id(app, "test.idle-timer-disabled").value as? String }

    /// Home → Send with seeded files → Create share session; returns the six-digit code.
    private func createSession(_ app: XCUIApplication, approval: Bool = false) -> String {
        UITest.skipWelcome(app)
        XCTAssertTrue(UITest.id(app, "home.send").waitForExistence(timeout: 15))
        UITest.id(app, "home.send").tap()
        XCTAssertTrue(UITest.id(app, "send.total").waitForExistence(timeout: 15), "seeded files are listed")
        let toggle = app.switches.matching(identifier: "send.approval").firstMatch
        XCTAssertTrue(toggle.exists)
        XCTAssertEqual(toggle.value as? String, "0", "Require approval is off by default")
        if approval {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            XCTAssertEqual(toggle.value as? String, "1")
        }
        UITest.id(app, "send.create").tap()
        let code = UITest.id(app, "session-code")
        XCTAssertTrue(code.waitForExistence(timeout: 30), "the session opens with its code")
        let value = (code.value as? String) ?? ""
        XCTAssertEqual(value.count, 6)
        XCTAssertTrue(value.allSatisfy(\.isNumber))
        return value
    }

    private func card(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "participant").containing(NSPredicate(format: "label == %@", name)).firstMatch
    }

    private func button(_ card: XCUIElement, _ id: String) -> XCUIElement {
        card.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    func testGuestSendsToAReceiverWhoJoinsWithTheCode() throws {
        let size = 6_000_000
        let app = UITest.app(extra: ["-seedSendFiles", "1", "-seedFileBytes", "\(size)"])
        app.launch()
        let code = createSession(app)
        XCTAssertTrue(UITest.id(app, "keep-open-banner").exists, "keep-open banner while waiting")
        eventually("waiting for receivers keeps the screen on") { idle(app) == "true" }
        shot(app, "session")

        let receiver = try peer("UITest iPad")
        let joined = try blocking { try await receiver.join(code: code) }
        XCTAssertEqual(joined.participant.status, "JOINED", "open join: no approval step")
        XCTAssertTrue(card(app, "UITest iPad").waitForExistence(timeout: 20), "the receiver appears on the session")

        let rx = try blocking(60) { await receiver.receive(joined.sessionId) }
        eventually("the receiver finishes", timeout: 120) { rx.state.value.phase.isFinal }
        XCTAssertEqual(rx.state.value.phase, .completed)
        let saved = try XCTUnwrap(rx.state.value.files.first?.savedURL)
        XCTAssertEqual(TestPeer.sha256(file: saved), TestPeer.sha256(TestPeer.seededContent(index: 0, size: size)))
        XCTAssertTrue(UITest.id(app, "dashboard-done").waitForExistence(timeout: 30), "the sender sees the result")
        shot(app, "dashboard-done")
    }

    func testGuestReceivesIntoDocumentsWithAVerifiedHashAndHistory() throws {
        let sender = try peer("UITest Mac")
        let (view, sum, tx) = try blocking { try await sender.share(name: "holiday.bin", size: 12_000_000) }
        let code = try XCTUnwrap(view.code)

        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        UITest.id(app, "home.receive").tap()
        let field = UITest.id(app, "receive.code-input")
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the simulator has no camera: code entry")
        XCTAssertTrue(UITest.id(app, "receive-code").exists)
        field.tap()
        field.typeText("000000")
        UITest.id(app, "receive.continue").tap()
        XCTAssertTrue(UITest.id(app, "receive.error").waitForExistence(timeout: 15), "an unknown code is refused")
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + code)
        UITest.id(app, "receive.continue").tap()

        XCTAssertTrue(UITest.id(app, "preview.receive").waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["holiday.bin"].exists)
        shot(app, "rx-preview")
        UITest.id(app, "preview.receive").tap()
        XCTAssertTrue(UITest.id(app, "rx.start").waitForExistence(timeout: 20), "open join goes straight to where to save")
        XCTAssertTrue(UITest.id(app, "security-words").exists)
        shot(app, "rx-save")

        // The sender is not serving yet: the receive is connecting, which keeps the screen on; Pause lets it sleep.
        UITest.id(app, "rx.start").tap()
        XCTAssertTrue(UITest.id(app, "rx-progress").waitForExistence(timeout: 15))
        XCTAssertTrue(UITest.id(app, "keepopen.lock-hint").exists, "Locking your iPhone pauses the transfer")
        eventually("connecting keeps the screen on") { idle(app) == "true" }
        shot(app, "rx-progress")
        UITest.id(app, "rx.pause").tap()
        eventually("paused: the screen may sleep") { idle(app) == "false" }
        XCTAssertTrue(UITest.id(app, "rx.resume").waitForExistence(timeout: 10))

        try blocking { await tx.start() }
        UITest.id(app, "rx.resume").tap()
        XCTAssertTrue(UITest.id(app, "rx-done").waitForExistence(timeout: 120), "the files arrive")
        XCTAssertTrue(UITest.id(app, "rx.result").exists)
        eventually("finished: the screen may sleep") { idle(app) == "false" }
        let hashes = UITest.id(app, "test.rx-sha256")
        eventually("the saved file's hash is computed") { (hashes.value as? String)?.isEmpty == false }
        XCTAssertEqual(hashes.value as? String, "holiday.bin=\(sum)", "Documents holds the file with the sender's SHA-256")
        shot(app, "rx-done")

        // Local History survives a relaunch.
        app.terminate()
        let again = UITest.app(reset: false)
        again.launch()
        UITest.tab(again, "History")
        XCTAssertTrue(UITest.id(again, "history.row.rx:\(view.id)").waitForExistence(timeout: 15))
    }

    func testAShareLinkOpensTheJoinPreview() throws {
        let sender = try peer("Link Sender")
        let (view, _, _) = try blocking { try await sender.share(name: "linked.txt", size: 1000) }
        let token = try XCTUnwrap(view.linkToken)
        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        XCTAssertTrue(UITest.id(app, "home").waitForExistence(timeout: 15))
        guard #available(iOS 16.4, *) else { throw XCTSkip("opening a URL from a UI test needs iOS 16.4") }
        app.open(URL(string: "shareanywhere://j/\(token)")!)
        XCTAssertTrue(UITest.id(app, "preview.receive").waitForExistence(timeout: 20), "the link opens the join preview")
        XCTAssertTrue(app.staticTexts["linked.txt"].exists)
        XCTAssertTrue(UITest.id(app, "rx-preview").exists, "nothing is joined until Receive is tapped")
    }

    func testTheCodeExpiresCreateNewCodeKeepsTheJoinedReceiver() throws {
        let app = UITest.app(extra: ["-seedSendFiles", "1", "-seedFileBytes", "1000"])
        app.launch()
        let code = createSession(app)
        let receiver = try peer("Joined Early")
        _ = try blocking { try await receiver.join(code: code) }
        XCTAssertTrue(card(app, "Joined Early").waitForExistence(timeout: 20))

        try blocking { try await TestPeer.advanceClock(seconds: 601) }
        XCTAssertTrue(UITest.id(app, "session.window-closed").waitForExistence(timeout: 30), "Code expired — Create new code")
        XCTAssertTrue(UITest.id(app, "session-expired").exists)
        XCTAssertFalse(UITest.id(app, "session-code").exists, "the old code is no longer shown")
        shot(app, "session-expired")
        let late = try peer("Too Late")
        XCTAssertThrowsError(try blocking { try await late.join(code: code) }, "an expired code admits nobody")

        UITest.id(app, "session.renew").tap()
        let fresh = UITest.id(app, "session-code")
        XCTAssertTrue(fresh.waitForExistence(timeout: 20))
        XCTAssertNotEqual(fresh.value as? String, code, "Create new code issues a different code")
        XCTAssertTrue(card(app, "Joined Early").exists, "the receiver who already joined is not affected")
    }

    func testRemoveAndBlockReceivers() throws {
        let app = UITest.app(extra: ["-seedSendFiles", "1", "-seedFileBytes", "1000"])
        app.launch()
        let code = createSession(app)
        let a = try peer("Peer Remove")
        let b = try peer("Peer Block")
        let ja = try blocking { try await a.join(code: code) }
        _ = try blocking { try await b.join(code: code) }
        XCTAssertTrue(card(app, "Peer Remove").waitForExistence(timeout: 20))
        XCTAssertTrue(card(app, "Peer Block").waitForExistence(timeout: 20))

        button(card(app, "Peer Remove"), "participant.remove").tap()
        eventually("removed on the server") {
            ((try? self.blocking { try await a.services.get(ja.sessionId) })?.me?.status) == "REMOVED"
        }
        button(card(app, "Peer Block"), "participant.block").tap()
        let confirm = app.alerts.buttons["Block"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        eventually("blocked on the server") {
            let me = (try? self.blocking { try await b.services.get(ja.sessionId) })?.me?.status
            return me == "BLOCKED" || me == nil
        }
        XCTAssertThrowsError(try blocking { try await b.join(code: code) }, "a blocked device cannot rejoin")
        shot(app, "session-removed-blocked")
    }

    func testRequireApprovalThenApprove() throws {
        let app = UITest.app(extra: ["-seedSendFiles", "1", "-seedFileBytes", "1000"])
        app.launch()
        let code = createSession(app, approval: true)
        XCTAssertTrue(UITest.id(app, "session.approval-on").exists)
        let r = try peer("Needs Approval")
        let joined = try blocking { try await r.join(code: code) }
        XCTAssertEqual(joined.participant.status, "REQUESTED")
        let approve = button(card(app, "Needs Approval"), "participant.approve")
        XCTAssertTrue(approve.waitForExistence(timeout: 20))
        shot(app, "session-approval")
        approve.tap()
        eventually("approved") { ((try? self.blocking { try await r.services.get(joined.sessionId) })?.me?.status) == "JOINED" }
    }

    func testKeepScreenOnFollowsTheSettingAndTheAppComingBack() throws {
        let app = UITest.app(extra: ["-seedSendFiles", "1", "-seedFileBytes", "1000"])
        app.launch()
        UITest.skipWelcome(app)
        UITest.tab(app, "Settings")
        let toggle = app.switches.matching(identifier: "settings.keep-screen-on").firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertEqual(toggle.value as? String, "0")
        UITest.tab(app, "Transfer")
        _ = createSession(app)
        XCTAssertTrue(app.staticTexts["Screen-on is off in Settings"].waitForExistence(timeout: 5))
        eventually("setting off: never kept on") { idle(app) == "false" }

        UITest.tab(app, "Settings")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        UITest.tab(app, "Transfer")
        eventually("setting on: waiting keeps the screen on") { idle(app) == "true" }

        XCUIDevice.shared.press(.home)
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        app.activate()
        eventually("on again after returning") { idle(app) == "true" }
    }

    func testLeavingTheAppPausesTheReceiveWhichResumesOnReturn() throws {
        let sender = try peer("Background Mac")
        let (view, sum, tx) = try blocking(120) { try await sender.share(name: "big.bin", size: 256 * 1024 * 1024) }
        try blocking { await tx.start() }
        let app = UITest.app(extra: ["-backgroundGrace", "2"])
        app.launch()
        UITest.skipWelcome(app)
        UITest.id(app, "home.receive").tap()
        let field = UITest.id(app, "receive.code-input")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        try field.typeText(XCTUnwrap(view.code))
        UITest.id(app, "receive.continue").tap()
        XCTAssertTrue(UITest.id(app, "preview.receive").waitForExistence(timeout: 15))
        UITest.id(app, "preview.receive").tap()
        XCTAssertTrue(UITest.id(app, "rx.start").waitForExistence(timeout: 20))
        UITest.id(app, "rx.start").tap()
        eventually("bytes moving", timeout: 60) { tx.state.value.receivers.first.map { $0.verified > 0 } ?? false }

        XCUIDevice.shared.press(.home)
        eventually("the receive pauses after the grace period", timeout: 30) {
            tx.state.value.receivers.first?.status == .paused || tx.state.value.final == .completed
        }
        XCTAssertNotEqual(tx.state.value.final, .completed, "the file is large enough to still be moving")
        app.activate()
        XCTAssertTrue(UITest.id(app, "rx-done").waitForExistence(timeout: 300), "resumed on return and finished")
        let hashes = UITest.id(app, "test.rx-sha256")
        eventually("hash computed", timeout: 60) { (hashes.value as? String)?.isEmpty == false }
        XCTAssertEqual(hashes.value as? String, "big.bin=\(sum)")
        XCTAssertEqual(UITest.id(app, "test.rx-duplicates").value as? String, "0", "resumed from the bitmap: no verified block again")
    }
}
