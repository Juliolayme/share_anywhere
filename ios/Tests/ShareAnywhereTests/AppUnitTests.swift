@testable import ShareAnywhere
import XCTest

/// App-level units: configuration parsing, string lookup and templates, Keychain storage (simulator Keychain).
final class AppUnitTests: XCTestCase {
    func testLaunchArgumentsSelectTheBackendAndTestHooks() {
        let c = AppConfig.load(arguments: ["app", "-uiTesting", "-resetState", "-seedHistory", "-backendURL", "http://127.0.0.1:9999"])
        XCTAssertEqual(c.backendURL.absoluteString, "http://127.0.0.1:9999")
        XCTAssertTrue(c.uiTesting && c.resetState && c.seedHistory)
        XCTAssertFalse(c.accounts, "accounts stay off until milestone 7.4 (CLAUDE.md §8b)")
        XCTAssertFalse(c.clipboard)
        let plain = AppConfig.load(arguments: ["app", "-seedHistory"])
        XCTAssertFalse(plain.seedHistory, "seeding needs -uiTesting")
    }

    func testStringsComeFromTheCatalogInBothLanguages() {
        L10n.override = "en"
        XCTAssertEqual(L10n.t("ios.hist"), "History")
        L10n.override = "vi"
        XCTAssertNotEqual(L10n.t("ios.hist"), "History")
        XCTAssertNotEqual(L10n.t("ios.hist"), "ios.hist", "the Vietnamese table is bundled")
        L10n.override = nil
    }

    func testTemplatesFillNamedPlaceholders() {
        XCTAssertEqual(L10n.fill("Retry in {time}", ["time": "0:42"]), "Retry in 0:42")
        XCTAssertEqual(L10n.fill("{a} and {b}", ["a": "x"]), "x and {b}")
        L10n.override = "en"
        XCTAssertEqual(L10n.t("product.version_ios", ["version": "1.0"]), "Share Anywhere for iOS 1.0")
        L10n.override = nil
    }

    func testKeychainStoreRoundTripsAndClears() async throws {
        let store = KeychainSecretStore(service: "app.shareanywhere.tests.\(UUID().uuidString)", account: "secret")
        let empty = try await store.read()
        XCTAssertNil(empty)
        try await store.write("one")
        try await store.write("two")
        let read = try await store.read()
        XCTAssertEqual(read, "two")
        try await store.clear()
        let cleared = try await store.read()
        XCTAssertNil(cleared)
    }

    func testTransferLaunchHooksNeedUITesting() {
        let c = AppConfig.load(arguments: ["app", "-uiTesting", "-seedSendFiles", "2", "-seedFileBytes", "500", "-backgroundGrace", "3"])
        XCTAssertEqual(c.seedSendFiles, 2)
        XCTAssertEqual(c.seedFileBytes, 500)
        XCTAssertEqual(c.backgroundGrace, 3)
        let plain = AppConfig.load(arguments: ["app", "-seedSendFiles", "2", "-backgroundGrace", "3"])
        XCTAssertEqual(plain.seedSendFiles, 0)
        XCTAssertEqual(plain.backgroundGrace, 20, "the real grace period outside UI tests")
        XCTAssertEqual(plain.publicURL, plain.backendURL, "share links default to the backend's origin")
    }

    func testCodesAndShareLinksAreParsedStrictly() {
        XCTAssertEqual(JoinInput.code(" 12a3-456 789"), "123456")
        let origin = URL(string: "https://share.example")!
        let token = String(repeating: "A", count: 43)
        XCTAssertEqual(JoinInput.linkToken("https://share.example/j/\(token)", publicOrigin: origin), token)
        XCTAssertNil(JoinInput.linkToken("https://evil.example/j/\(token)", publicOrigin: origin), "another origin")
        XCTAssertNil(JoinInput.linkToken("http://share.example/j/\(token)", publicOrigin: origin), "another scheme")
        XCTAssertNil(JoinInput.linkToken("https://share.example/j/short", publicOrigin: origin))
        XCTAssertNil(JoinInput.linkToken("https://share.example/j/\(token)?x=1", publicOrigin: origin))
        XCTAssertNil(JoinInput.linkToken("https://share.example/x/\(token)", publicOrigin: origin))
    }

    func testTransferTextFormats() {
        L10n.override = "en"
        XCTAssertEqual(TransferText.eta(nil), "Estimating time…")
        XCTAssertEqual(TransferText.eta(42), "42 s left")
        XCTAssertEqual(TransferText.eta(130), "2 min 10 s left")
        XCTAssertEqual(TransferText.code("123456"), "123 456")
        XCTAssertEqual(TransferText.clock(65), "1:05")
        XCTAssertEqual(TransferText.files(1), "1 file")
        L10n.override = nil
    }

    func testQRCodeImageIsGenerated() {
        let image = QRCodeView.make("http://127.0.0.1:8080/j/" + String(repeating: "x", count: 43))
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.size.width ?? 0, 100)
    }
}
