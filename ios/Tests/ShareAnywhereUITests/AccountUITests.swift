import SAAccount
import XCTest

/// Accounts and Clipboard Sync on the simulator (milestone 7.4) against the native backend: sign up from Settings,
/// add this device, set up the key with the recovery phrase, sync text with iOS's Paste control, sign out to a new
/// anonymous identity; and a second account device (in the test runner) that pairs the app by the pasted code and
/// exchanges encrypted clipboard items with it.
final class AccountUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// An element whose label contains `text` (timeline rows combine their texts into one label).
    private func row(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// A random tag without digits: `detectPatterns(.number)` would mark text with a number as a probable code.
    private func letters() -> String { String((0 ..< 8).map { _ in "abcdefghijklmnopqrstuvwxyz".randomElement()! }) }

    private func email() -> String { "ios-ui-\(UUID().uuidString.prefix(10).lowercased())@example.com" }
    private let password = "correct horse battery staple 42"

    /// Syncs `text` through the fallback button and iOS's Allow Paste prompt. iOS's Paste control is shown (asserted
    /// by the callers) but XCUITest cannot operate it: a tap on the secure system control has no effect under test, so
    /// tapping it is on the real-device checklist.
    private func paste(_ app: XCUIApplication, _ text: String) {
        UIPasteboard.general.string = text
        UITest.tapRevealed(app, UITest.id(app, "clipboard.sync-fallback"))
        allowPaste(app)
    }

    /// iOS's paste prompt for a programmatic read (in the app or from SpringBoard, depending on the runtime). Simulator
    /// runtimes that do not prompt leave nothing to tap; the caller's assertion on the synced row decides.
    private func allowPaste(_ app: XCUIApplication) {
        let allow = app.alerts.buttons["Allow Paste"].firstMatch
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"].firstMatch
        if allow.waitForExistence(timeout: 8) { allow.tap() } else if springboard.waitForExistence(timeout: 2) { springboard.tap() }
    }

    private func signUpInApp(_ app: XCUIApplication, _ address: String) {
        UITest.tab(app, "Settings")
        UITest.id(app, "settings.signin").tap()
        XCTAssertTrue(UITest.id(app, "signin").waitForExistence(timeout: 10))
        UITest.id(app, "signin.create").tap()
        let field = UITest.id(app, "signup.email")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(address)
        let pw = UITest.id(app, "signup.password")
        pw.tap()
        pw.typeText(password)
        UITest.id(app, "signup.submit").tap()
    }

    func testSignUpSetUpTheKeySyncClipboardAndSignOut() throws {
        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        XCTAssertTrue(UITest.id(app, "home").waitForExistence(timeout: 15))
        let before = UITest.id(app, "test.device-id")
        eventually("identity") { (before.value as? String)?.isEmpty == false }
        let firstDevice = before.value as? String

        signUpInApp(app, email())
        guard UITest.expect(app, UITest.id(app, "trust"), timeout: 30, "after sign-up: add this device") else { return }
        shot(app, "trust")
        UITest.id(app, "trust.continue").tap()
        XCTAssertTrue(UITest.id(app, "key-setup").waitForExistence(timeout: 30))
        let phrase = UITest.id(app, "key-setup.phrase")
        XCTAssertTrue(phrase.waitForExistence(timeout: 60), "the recovery phrase is created on the device")
        XCTAssertEqual((phrase.value as? String)?.split(separator: " ").count, 12)
        shot(app, "key-setup")
        UITest.flip(app, "key-setup.saved", to: true)
        UITest.id(app, "key-setup.continue").tap()
        XCTAssertTrue(UITest.id(app, "checklist").waitForExistence(timeout: 30))
        shot(app, "checklist")
        UITest.id(app, "checklist.clipboard").tap()
        XCTAssertTrue(UITest.id(app, "account.close").gone(timeout: 10), "Go to Clipboard closes the account sheet")

        XCTAssertTrue(UITest.id(app, "clipboard").waitForExistence(timeout: 10))
        XCTAssertTrue(UITest.id(app, "clipboard.empty").waitForExistence(timeout: 30), "an empty timeline once synced")
        let text = "From the iOS simulator \(UUID().uuidString.prefix(6))"
        XCTAssertTrue(app.buttons["Paste"].firstMatch.waitForExistence(timeout: 10), "iOS's Paste control is the Sync action")
        paste(app, text)
        guard UITest.expect(app, row(app, text), timeout: 30, "the item is in the timeline") else { return }
        shot(app, "clipboard")

        // The fallback button reads the pasteboard itself (iOS confirms with its paste prompt).
        let reads = Int(UITest.id(app, "test.pasteboard-reads").value as? String ?? "") ?? 0
        let viaFallback = "Through the fallback button \(letters())"
        UIPasteboard.general.string = viaFallback
        UITest.tapRevealed(app, UITest.id(app, "clipboard.sync-fallback"))
        allowPaste(app)
        XCTAssertTrue(row(app, viaFallback).waitForExistence(timeout: 30), "the fallback read syncs the text")
        XCTAssertGreaterThan(Int(UITest.id(app, "test.pasteboard-reads").value as? String ?? "") ?? 0, reads)

        UITest.tab(app, "Settings")
        UITest.id(app, "settings.signout").tap()
        XCTAssertTrue(UITest.id(app, "signout").waitForExistence(timeout: 10))
        UITest.id(app, "signout.confirm").tap()
        XCTAssertTrue(UITest.id(app, "settings.guest").waitForExistence(timeout: 30), "a guest again")
        eventually("a new anonymous device") {
            let now = UITest.id(app, "test.device-id").value as? String
            return now?.isEmpty == false && now != firstDevice
        }
    }

    func testAnotherDevicePairsTheAppByThePastedCodeAndClipboardItemsCross() throws {
        let other = try AccountPeer()
        let address = email()
        try blocking(120) { try await other.signUpWithKey(email: address, password: self.password) }

        let app = UITest.app()
        app.launch()
        UITest.skipWelcome(app)
        UITest.tab(app, "Settings")
        UITest.id(app, "settings.signin").tap()
        let field = UITest.id(app, "signin.email")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(address)
        let pw = UITest.id(app, "signin.password")
        pw.tap()
        pw.typeText(password)
        UITest.id(app, "signin.submit").tap()
        XCTAssertTrue(UITest.id(app, "trust").waitForExistence(timeout: 20))
        UITest.id(app, "trust.continue").tap()
        let code = UITest.id(app, "key-pair.code")
        guard UITest.expect(app, code, timeout: 60, "the account has a key: pair with another device") else { return }
        let payload = try XCTUnwrap(code.value as? String)
        shot(app, "key-pair")
        try blocking(60) { try await other.sendKey(to: payload) }
        XCTAssertTrue(UITest.id(app, "checklist").waitForExistence(timeout: 30), "the key arrived and verified")
        UITest.id(app, "checklist.clipboard").tap()
        XCTAssertTrue(UITest.id(app, "account.close").gone(timeout: 10), "Go to Clipboard closes the account sheet")

        let fromPeer = "From the other device \(UUID().uuidString.prefix(6))"
        try blocking(60) { try await other.capture(fromPeer) }
        XCTAssertTrue(row(app, fromPeer).waitForExistence(timeout: 30), "decrypted on the app")
        let fromApp = "From the app \(UUID().uuidString.prefix(6))"
        paste(app, fromApp)
        guard UITest.expect(app, row(app, fromApp), timeout: 30, "the pasted item is in the timeline") else { return }
        eventually("decrypted on the other device", timeout: 30) {
            (try? self.blocking(20) { try await other.texts() })?.contains(fromApp) == true
        }

        // Foreground capture: text copied while the app is in the background is not read there; coming back captures
        // it (after iOS's paste prompt) and the other device decrypts it.
        let copied = "Copied in another app \(letters())"
        XCUIDevice.shared.press(.home)
        UIPasteboard.general.string = copied
        RunLoop.current.run(until: Date().addingTimeInterval(5))
        let seenWhileAway = try blocking(20) { try await other.texts() }
        XCTAssertFalse(seenWhileAway.contains(copied), "nothing is captured while the app is in the background")
        app.activate()
        allowPaste(app)
        XCTAssertTrue(row(app, copied).waitForExistence(timeout: 30), "captured when the app is back in front")
        eventually("the captured item reaches the other device", timeout: 30) {
            (try? self.blocking(20) { try await other.texts() })?.contains(copied) == true
        }
        try blocking(30) { await other.dispose() }
    }
}

/// A second device of the same account in the test runner: its own anonymous identity, signed in and added, with the
/// account key in memory.
final class AccountPeer: @unchecked Sendable {
    let identity: IdentityManager
    let api: LiveAccountAPI
    let keys: AccountKeys
    let dir: URL
    private var account = ""
    private var device = ""
    private var engine: ClipboardEngine?

    private final class Secrets: SecretStore, @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?
        func read() async throws -> String? { lock.locked { value } }
        func write(_ secret: String) async throws { lock.locked { value = secret } }
        func clear() async throws { lock.locked { value = nil } }
    }

    init() throws {
        let client = try APIClient(baseURL: TestPeer.backend, requireHTTPS: false, userAgent: "ShareAnywhere-UITest-Account")
        identity = IdentityManager(api: DeviceAPI(client: client), store: Secrets(), platform: "ios")
        api = LiveAccountAPI(client: client, identity: identity)
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("acct-peer-\(UUID().uuidString)")
        keys = AccountKeys(
            api: api, vault: AccountKeyVault(url: dir.appendingPathComponent("keys.json"), sealer: MemorySealer()),
            meta: SyncMeta(url: dir.appendingPathComponent("meta.json"))
        )
    }

    /// Creates the account with this device added and the key set up (the first device of the account).
    func signUpWithKey(email: String, password: String) async throws {
        _ = try await identity.accessToken()
        let r = try await api.signUp(email: email, password: password, addDevice: true)
        await identity.adoptToken(r.accessToken, expiresIn: r.expiresIn)
        account = r.account.id
        device = r.device.id
        let check = try await keys.check(account: account, device: device)
        XCTAssertEqual(check.status, .setup)
        let prepared = try await keys.prepareSetup(account: account)
        _ = try await api.setupKeys(prepared.request)
        try await prepared.commit(keys.store(account))
        _ = try await keys.check(account: account, device: device)
    }

    func sendKey(to payload: String) async throws {
        let found = try await keys.lookupCode(payload)
        try await keys.sendKey(account: account, device: device, to: XCTUnwrap(found))
    }

    private func clipboard() async throws -> ClipboardEngine {
        if let engine { return engine }
        let e = await ClipboardEngine(
            api: api, keys: .of(keys.store(account)), store: ClipboardStore(url: dir.appendingPathComponent("cb.json")), userId: account,
            deviceId: device
        )
        await e.start()
        engine = e
        return e
    }

    func capture(_ text: String) async throws {
        let r = try await clipboard().capture(text, source: .manual)
        guard case .synced = r else { throw CryptoError("capture", "\(r)") }
    }

    func texts() async throws -> [String] {
        let e = try await clipboard()
        await e.refresh()
        return e.state.value.items.compactMap(\.text)
    }

    func dispose() async {
        await engine?.stop()
        try? FileManager.default.removeItem(at: dir)
    }
}
