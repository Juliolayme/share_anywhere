import SATransferRuntime
import XCTest

/// Cloud Distribution on the simulator (docs/phases/PHASE_8_ROUTE_TURN_CLOUD.md, PRD §2 "iOS long transfers"): a guest
/// sender sees "Sign in to let large transfers finish in the background"; a signed-in sender consents (the sheet says
/// Cloud lets a transfer finish while the app is not in the foreground, and shows "Cost unknown" without configured
/// prices), uploads, and leaves the app; the receiver who joined meanwhile finishes from the cloud while the app is in
/// the background. The CI backend runs with Cloud on against an S3-compatible store.
final class CloudUITests: XCTestCase {
    var peers: [TestPeer] = []
    private let password = "correct horse battery staple 42"

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

    func testAGuestSenderSeesSignInToFinishLargeTransfersInTheBackground() throws {
        let app = UITest.app(extra: ["-seedSendFiles", "1"])
        app.launch()
        UITest.skipWelcome(app)
        XCTAssertTrue(UITest.id(app, "home.send").waitForExistence(timeout: 15))
        UITest.id(app, "home.send").tap()
        let note = UITest.id(app, "send.cloud-signin")
        XCTAssertTrue(UITest.scrollTo(app, "send.cloud-signin", timeout: 15).exists, "the Cloud option is shown to guests")
        XCTAssertEqual(note.label, "Sign in to let large transfers finish in the background")
        XCTAssertFalse(app.switches.matching(identifier: "send.cloud").firstMatch.isEnabled, "disabled for a guest")
        shot(app, "send-cloud-guest")
    }

    func testASignedInSenderConsentsAndTheTransferFinishesFromTheCloudInTheBackground() throws {
        let size = 6_000_000
        let app = UITest.app(extra: ["-seedSendFiles", "1", "-seedFileBytes", "\(size)", "-backgroundGrace", "3"])
        app.launch()
        UITest.skipWelcome(app)
        XCTAssertTrue(UITest.id(app, "home").waitForExistence(timeout: 15))

        // Sign up without adding the device (Cloud needs the account only).
        UITest.tab(app, "Settings")
        UITest.id(app, "settings.signin").tap()
        XCTAssertTrue(UITest.id(app, "signin").waitForExistence(timeout: 10))
        UITest.id(app, "signin.create").tap()
        let field = UITest.id(app, "signup.email")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("ios-cloud-\(UUID().uuidString.prefix(10).lowercased())@example.com")
        let pw = UITest.id(app, "signup.password")
        pw.tap()
        pw.typeText(password)
        UITest.id(app, "signup.submit").tap()
        guard UITest.expect(app, UITest.id(app, "trust"), timeout: 30, "after sign-up") else { return }
        UITest.flip(app, "trust.add", to: false)
        UITest.id(app, "trust.continue").tap()
        XCTAssertTrue(UITest.id(app, "trust").gone(timeout: 15), "the account sheet closes")

        // TR-3: Cloud transfer asks for consent with the estimate and the background line.
        UITest.tab(app, "Transfer")
        UITest.id(app, "home.send").tap()
        XCTAssertTrue(UITest.scrollTo(app, "send.cloud", timeout: 15).exists)
        UITest.flip(app, "send.cloud", to: true)
        XCTAssertTrue(UITest.id(app, "cloud-consent").waitForExistence(timeout: 15), "the consent sheet opens")
        XCTAssertTrue(UITest.id(app, "cloud.background").exists)
        XCTAssertTrue(UITest.id(app, "cloud.cost").waitForExistence(timeout: 15))
        XCTAssertEqual(UITest.id(app, "cloud.cost").label, "Cost unknown")
        shot(app, "cloud-consent")
        UITest.id(app, "cloud.approve").tap()
        XCTAssertTrue(UITest.id(app, "cloud-consent").gone(timeout: 15))
        eventually("Cloud transfer is on") { app.switches.matching(identifier: "send.cloud").firstMatch.value as? String == "1" }
        UITest.scrollTo(app, "send.create").tap()
        let codeEl = UITest.id(app, "session-code")
        XCTAssertTrue(codeEl.waitForExistence(timeout: 30))
        let code = try XCTUnwrap(codeEl.value as? String)
        let card = UITest.id(app, "session.cloud")
        XCTAssertTrue(card.waitForExistence(timeout: 30), "the upload card is on the session screen")
        eventually("uploaded to the cloud", timeout: 90) { card.value as? String == "ready" }
        shot(app, "session-cloud-ready")

        // The receiver joins and gets the key over signaling while the app is in the foreground.
        let receiver = try TestPeer()
        try blocking(90) { try await receiver.ready(name: "Cloud Receiver") }
        peers.append(receiver)
        let joined = try blocking { try await receiver.join(code: code) }
        let rx = try blocking(60) { await receiver.receive(joined.sessionId, choose: false, cloud: true, peers: NoPeers()) }
        eventually("the receiver holds the key", timeout: 30) { (try? self.blocking { await rx.cloudReadyCount() }) == 1 }

        // The sender leaves the app; with no network path to it, the receiver finishes from the cloud.
        XCUIDevice.shared.press(.home)
        try blocking { await rx.choose(SaveTarget(kind: .documents, label: "peer")) }
        eventually("finished from the cloud", timeout: 120) { rx.state.value.phase.isFinal }
        XCTAssertEqual(rx.state.value.phase, .completed)
        XCTAssertEqual(rx.state.value.route, "cloud")
        let saved = try XCTUnwrap(rx.state.value.files.first?.savedURL)
        XCTAssertEqual(TestPeer.sha256(file: saved), TestPeer.sha256(TestPeer.seededContent(index: 0, size: size)))
        app.activate()
        XCTAssertTrue(UITest.id(app, "dashboard-done").waitForExistence(timeout: 30), "back in the app, the sender sees the result")
        shot(app, "dashboard-done-cloud")
    }
}
