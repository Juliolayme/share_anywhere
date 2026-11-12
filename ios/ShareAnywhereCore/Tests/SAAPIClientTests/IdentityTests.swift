import Foundation
@testable import SAAPIClient
import XCTest

private func b64u(_ s: String) -> String {
    Data(s.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func jwt(_ payload: String) -> String { [#"{"alg":"EdDSA"}"#, payload, "sig"].map(b64u).joined(separator: ".") }

private func token(_ gen: Int) -> String { jwt(#"{"sub":"dev-1","typ":"device","gen":\#(gen)}"#) }

/// Mutable test clock.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var now = Date(timeIntervalSince1970: 1_800_000_000)
    func get() -> Date { lock.withLock { now } }
    func advance(_ s: TimeInterval) { lock.withLock { now = now.addingTimeInterval(s) } }
}

actor MemorySecrets: SecretStore {
    var secret: String?
    var writes: [String] = []
    init(_ s: String? = nil) { secret = s }
    func read() async throws -> String? { secret }
    func write(_ secret: String) async throws {
        self.secret = secret
        writes.append(secret)
    }

    func clear() async throws { secret = nil }
}

/// A scripted backend: hands out rotating secrets and tokens, and records what it was sent.
actor FakeDevices: DeviceEndpoints {
    var gen = 0
    var creates: [CreateDeviceRequest] = []
    var refreshed: [String] = []
    var renameCalls = 0
    var createErrors: [APIError] = []
    var refreshError: APIError?
    var renameErrors: [APIError] = []
    var refreshDelayNs: UInt64 = 0
    let device = Device(
        id: "dev-1",
        kind: "anonymous",
        displayName: "iPhone",
        platform: "ios",
        createdAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z"
    )

    func session() -> DeviceSession {
        gen += 1
        return DeviceSession(
            device: device,
            accessToken: token(gen),
            expiresIn: 900,
            refreshSecret: "secret-\(gen)",
            serverTime: "2027-01-15T08:00:00Z"
        )
    }

    func setCreateErrors(_ e: [APIError]) { createErrors = e }
    func setRefreshError(_ e: APIError?) { refreshError = e }
    func setRenameErrors(_ e: [APIError]) { renameErrors = e }
    func setRefreshDelay(_ ns: UInt64) { refreshDelayNs = ns }

    func create(_ request: CreateDeviceRequest) async throws -> DeviceSession {
        creates.append(request)
        if !createErrors.isEmpty { throw createErrors.removeFirst() }
        return session()
    }

    func refresh(secret: String) async throws -> DeviceSession {
        refreshed.append(secret)
        if refreshDelayNs > 0 { try await Task.sleep(nanoseconds: refreshDelayNs) }
        if let e = refreshError { throw e }
        return session()
    }

    func current(token _: String) async throws -> Device { device }

    func rename(token: String, displayName: String) async throws -> Device {
        renameCalls += 1
        if !renameErrors.isEmpty { throw renameErrors.removeFirst() }
        XCTAssertFalse(token.isEmpty)
        var d = device
        d.displayName = displayName
        return d
    }

    func reset(token _: String) async throws -> DeviceSession { session() }
}

private func apiError(_ status: Int, _ code: String, retry: Int? = nil, body: [String: JSONValue]? = nil) -> APIError {
    APIError(status: status, code: code, message: code, retryAfterSeconds: retry, body: body)
}

/// Guest-first identity on iOS (docs/SECURITY_MODEL.md §4), the cases of Android's IdentityManagerTest.
final class IdentityTests: XCTestCase {
    func manager(_ api: FakeDevices, _ store: MemorySecrets, clock: TestClock = TestClock()) -> IdentityManager {
        IdentityManager(
            api: api,
            store: store,
            platform: "ios",
            clock: { clock.get() },
            solver: { t, d in try ProofOfWork.solve(token: t, difficulty: d) }
        )
    }

    func testFirstLaunchCreatesAnAnonymousDeviceWithBodyTransportAndStoresTheSecret() async throws {
        let api = FakeDevices(), store = MemorySecrets()
        let m = manager(api, store)
        await m.bootstrap()
        let state = await m.state
        XCTAssertEqual(state.status, .ready)
        XCTAssertEqual(state.claims?.sub, "dev-1")
        let creates = await api.creates
        XCTAssertEqual(creates.map(\.transport), ["body"])
        XCTAssertEqual(creates.first?.platform, "ios")
        let secret = await store.secret
        XCTAssertEqual(secret, "secret-1")
    }

    func testSolvesTheProofOfWorkWhenTheServerAsksForIt() async throws {
        let api = FakeDevices(), store = MemorySecrets()
        let body: [String: JSONValue] = [
            "error": .string("pow_required"), "message": .string("x"),
            "challenge": .object(["token": .string("t"), "difficulty": .number(3), "expires_in": .number(120)])
        ]
        await api.setCreateErrors([apiError(428, "pow_required", body: body)])
        let m = manager(api, store)
        await m.bootstrap()
        let creates = await api.creates
        XCTAssertEqual(creates.count, 2)
        XCTAssertNil(creates[0].pow)
        XCTAssertEqual(creates[1].pow, PowSolution(token: "t", solution: "4"))
        let status = await m.state.status
        XCTAssertEqual(status, .ready)
    }

    func testStoredSecretIsRotatedOnRefreshAndTheNewOneIsPersistedFirst() async throws {
        let api = FakeDevices(), store = MemorySecrets("old-secret")
        let m = manager(api, store)
        let t = try await m.accessToken()
        XCTAssertEqual(t, token(1))
        let refreshed = await api.refreshed
        XCTAssertEqual(refreshed, ["old-secret"])
        let writes = await store.writes
        XCTAssertEqual(writes, ["secret-1"])
    }

    func testRefreshesWhenTheAccessTokenIsAboutToExpire() async throws {
        let api = FakeDevices(), store = MemorySecrets(), clock = TestClock()
        let m = manager(api, store, clock: clock)
        _ = try await m.accessToken()
        clock.advance(900 - 3) // inside the expiry skew
        let t = try await m.accessToken()
        XCTAssertEqual(t, token(2))
        let refreshed = await api.refreshed
        XCTAssertEqual(refreshed, ["secret-1"])
    }

    func testConcurrentCallersShareOneRefreshSoNoSecretIsPresentedTwice() async throws {
        let api = FakeDevices(), store = MemorySecrets("s0")
        await api.setRefreshDelay(50_000_000)
        let m = manager(api, store)
        let tokens = try await withThrowingTaskGroup(of: String.self) { g in
            for _ in 0 ..< 8 {
                g.addTask { try await m.accessToken() }
            }
            return try await g.reduce(into: [String]()) { $0.append($1) }
        }
        XCTAssertEqual(Set(tokens), [token(1)])
        let refreshed = await api.refreshed
        XCTAssertEqual(refreshed, ["s0"])
    }

    func testStaleTokenAnswerRefreshesAndRetriesOnce() async throws {
        let api = FakeDevices(), store = MemorySecrets()
        await api.setRenameErrors([apiError(401, "device_token_expired")])
        let m = manager(api, store)
        let d = try await m.rename("Kitchen iPad")
        XCTAssertEqual(d.displayName, "Kitchen iPad")
        let calls = await api.renameCalls
        XCTAssertEqual(calls, 2)
        let refreshed = await api.refreshed
        XCTAssertEqual(refreshed, ["secret-1"])
    }

    func testOtherErrorsAreNotRetried() async throws {
        let api = FakeDevices(), store = MemorySecrets()
        await api.setRenameErrors([apiError(401, "account_required"), apiError(500, "internal")])
        let m = manager(api, store)
        do {
            _ = try await m.rename("x")
            XCTFail("expected an error")
        } catch let e as APIError {
            XCTAssertEqual(e.code, "account_required")
        }
        let calls = await api.renameCalls
        XCTAssertEqual(calls, 1)
    }

    func testRefreshReuseResetsTheIdentity() async throws {
        let api = FakeDevices(), store = MemorySecrets("stolen")
        await api.setRefreshError(apiError(401, "refresh_reused"))
        let m = manager(api, store)
        await m.bootstrap()
        let state = await m.state
        XCTAssertEqual(state.status, .ready)
        XCTAssertTrue(state.replaced)
        let creates = await api.creates.count
        XCTAssertEqual(creates, 1)
        await m.dismissReplaced()
        let replaced = await m.state.replaced
        XCTAssertFalse(replaced)
    }

    func testAnExpiredIdentityIsReplacedSilently() async throws {
        let api = FakeDevices(), store = MemorySecrets("old")
        await api.setRefreshError(apiError(401, "refresh_expired"))
        let m = manager(api, store)
        await m.bootstrap()
        let state = await m.state
        XCTAssertEqual(state.status, .ready)
        XCTAssertFalse(state.replaced)
    }

    func testRateLimitShowsTheWaitFromTheServer() async throws {
        let api = FakeDevices(), store = MemorySecrets(), clock = TestClock()
        await api.setCreateErrors([apiError(429, "rate_limited", retry: 42)])
        let m = manager(api, store, clock: clock)
        await m.bootstrap()
        let state = await m.state
        XCTAssertEqual(state.status, .rateLimited)
        XCTAssertEqual(state.retryAt, clock.get().addingTimeInterval(42))
    }

    func testUnreachableBackendIsOffline() async throws {
        actor Down: DeviceEndpoints {
            func create(_: CreateDeviceRequest) async throws -> DeviceSession { throw NetworkError(underlying: "down") }
            func refresh(secret _: String) async throws -> DeviceSession { throw NetworkError(underlying: "down") }
            func current(token _: String) async throws -> Device { throw NetworkError(underlying: "down") }
            func rename(token _: String, displayName _: String) async throws -> Device { throw NetworkError(underlying: "down") }
            func reset(token _: String) async throws -> DeviceSession { throw NetworkError(underlying: "down") }
        }
        let m = IdentityManager(api: Down(), store: MemorySecrets(), platform: "ios")
        await m.bootstrap()
        let status = await m.state.status
        XCTAssertEqual(status, .offline)
    }

    func testResetReplacesTheIdentityAndStoresItsSecret() async throws {
        let api = FakeDevices(), store = MemorySecrets()
        let m = manager(api, store)
        await m.bootstrap()
        _ = try await m.reset()
        let secret = await store.secret
        XCTAssertEqual(secret, "secret-2")
        let t = try await m.accessToken()
        XCTAssertEqual(t, token(2))
    }

    func testSecretsTravelInTheBodyOnly() async throws {
        let device = #"{"id":"d","kind":"anonymous","display_name":"x","platform":"ios","created_at":"a","last_seen_at":"b"}"#
        let t = FakeTransport(
            status: 200,
            body: #"{"device":\#(device),"access_token":"tok","expires_in":900,"refresh_secret":"new","server_time":"2027-01-01T00:00:00Z"}"#
        )
        let client = try APIClient(baseURL: URL(string: "http://127.0.0.1:8080")!, transport: t, requireHTTPS: false, userAgent: "t")
        _ = try await DeviceAPI(client: client).refresh(secret: "the-secret")
        let r = try XCTUnwrap(t.requests.first)
        XCTAssertFalse(r.url!.absoluteString.contains("the-secret"))
        XCTAssertFalse((r.allHTTPHeaderFields ?? [:]).values.contains { $0.contains("the-secret") })
        let body = try XCTUnwrap(r.httpBody.flatMap { String(bytes: $0, encoding: .utf8) })
        XCTAssertTrue(body.contains(#""refresh_secret":"the-secret""#))
    }

    func testProofOfWorkMatchesTheServerAndTheOtherClients() throws {
        XCTAssertEqual(ProofOfWork.leadingZeroBits([0, 0x0F]), 12)
        XCTAssertEqual(ProofOfWork.leadingZeroBits([0x80]), 0)
        XCTAssertTrue(ProofOfWork.verify(token: "t", solution: "0", difficulty: 1))
        XCTAssertFalse(ProofOfWork.verify(token: "t", solution: "0", difficulty: 2))
        XCTAssertTrue(ProofOfWork.verify(token: "t", solution: "4", difficulty: 3))
        XCTAssertFalse(ProofOfWork.verify(token: "t", solution: "4", difficulty: 4))
        XCTAssertEqual(try ProofOfWork.solve(token: "t", difficulty: 3), "4")
        let s = try ProofOfWork.solve(token: "challenge-token", difficulty: 12)
        XCTAssertTrue(ProofOfWork.verify(token: "challenge-token", solution: s, difficulty: 12))
        XCTAssertLessThanOrEqual(s.count, 32)
    }

    func testTokenClaims() {
        let guest = TokenClaims.decode(jwt(#"{"sub":"dev-1","exp":1800000900}"#))
        XCTAssertEqual(guest, TokenClaims(sub: "dev-1", acct: nil, dl: false, exp: 1_800_000_900))
        let account = TokenClaims.decode(jwt(#"{"sub":"dev-1","acct":"acc-9","dl":true}"#))
        XCTAssertEqual(account?.acct, "acc-9")
        XCTAssertEqual(account?.dl, true)
        XCTAssertNil(TokenClaims.decode(jwt(#"{"sub":"d","acct":""}"#))?.acct)
        XCTAssertNil(TokenClaims.decode("not-a-jwt"))
        XCTAssertNil(TokenClaims.decode("a..c"))
    }
}
