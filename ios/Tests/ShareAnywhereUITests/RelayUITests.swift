import SATransferRuntime
import XCTest

/// Forced relay on the simulator (docs/phases/PHASE_8_ROUTE_TURN_CLOUD.md, docs/ADR/0029-turn-tls-and-test-relay.md):
/// the app receives on a relay policy step (`-routeStep`), the `TestPeer` sender is relay-only too, and both reach each
/// other only through the CI coturn on the runner, over UDP and over TLS (its self-signed certificate accepted through
/// `-insecureTurnTLS`). The connection is classified from WebRTC stats and the saved file matches the sender's SHA-256.
final class RelayUITests: XCTestCase {
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

    func testRelayOverUdpCarriesTheTransfer() throws { try relayed(step: "relay-udp") }

    func testRelayOverTlsCarriesTheTransfer() throws { try relayed(step: "relay-tls") }

    private func relayed(step: String) throws {
        let sender = try TestPeer()
        try blocking(90) { try await sender.ready(name: "Relay Sender") }
        peers.append(sender)
        let name = "relay-\(step).bin"
        let (view, sum, tx) = try blocking { try await sender.share(name: name, size: 6 * 1024 * 1024 + 7, relayOnly: true) }
        try blocking { await tx.start() }
        let code = try XCTUnwrap(view.code)

        let app = UITest.app(extra: ["-routeStep", step, "-insecureTurnTLS"])
        app.launch()
        UITest.skipWelcome(app)
        UITest.id(app, "home.receive").tap()
        let field = UITest.id(app, "receive.code-input")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(code)
        UITest.id(app, "receive.continue").tap()
        XCTAssertTrue(UITest.id(app, "preview.receive").waitForExistence(timeout: 15))
        UITest.id(app, "preview.receive").tap()
        XCTAssertTrue(UITest.id(app, "rx.start").waitForExistence(timeout: 20))
        UITest.id(app, "rx.start").tap()
        XCTAssertTrue(UITest.id(app, "rx-done").waitForExistence(timeout: 180), "the file arrives over the relay (\(step))")
        let kind = UITest.id(app, "test.rx-route-kind")
        XCTAssertEqual(kind.value as? String, step, "the selected pair is a \(step) relay candidate")
        let hashes = UITest.id(app, "test.rx-sha256")
        eventually("the saved file's hash is computed") { (hashes.value as? String)?.isEmpty == false }
        XCTAssertEqual(hashes.value as? String, "\(name)=\(sum)")
        shot(app, "rx-relay-\(step)")
        try blocking { await sender.close(view.id) }
    }
}
