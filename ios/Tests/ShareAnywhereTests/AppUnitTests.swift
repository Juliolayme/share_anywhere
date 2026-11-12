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
}
