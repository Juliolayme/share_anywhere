import Foundation

/// Where the device refresh secret lives between launches: the Keychain in the app
/// (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable; docs/SECURITY_MODEL.md §4).
public protocol SecretStore: Sendable {
    func read() async throws -> String?
    func write(_ secret: String) async throws
    func clear() async throws
}

/// What the UI shows about this installation's anonymous identity (docs/UX_SCREEN_MAP.md ON-2).
public enum IdentityStatus: Sendable, Equatable { case loading, solvingChallenge, ready, offline, rateLimited, failed }

public struct IdentityState: Sendable, Equatable {
    public var status: IdentityStatus = .loading
    /// The device as the server last described it (name, platform, anonymous since).
    public var device: Device?
    /// When a rate-limited bootstrap retries by itself.
    public var retryAt: Date?
    /// The API error code behind `.failed`.
    public var errorCode: String?
    /// Set when refresh-secret reuse made the server revoke the device and a new identity replaced it.
    public var replaced = false
    /// Claims of the current access token, for display state only.
    public var claims: TokenClaims?

    public init() {}
}

/// Guest-first anonymous device identity (PRD §2, docs/ARCHITECTURE.md §3, docs/SECURITY_MODEL.md §4), the twin of
/// Android's `IdentityManager`:
/// - First launch: `POST /v1/devices/anonymous` with `transport: "body"`, solving the proof of work on `428`.
/// - The access token lives only in memory; it is refreshed a minute before expiry and whenever a request gets
///   `401 device_token_expired` / `device_token_invalid` (one retry).
/// - Every refresh rotates the secret; the new secret is stored before the new token is used. Refreshes run one at a
///   time, so this process never presents the same secret twice.
/// - `401 refresh_reused` means the server saw an old secret and revoked the device: a new identity replaces it
///   (`replaced`). Any other `401` on refresh also creates a new identity, silently.
/// - `429` shows the wait and retries when it ends; network errors show offline.
public actor IdentityManager {
    public static let refreshMargin: TimeInterval = 60
    static let minDelay: TimeInterval = 5
    static let expirySkew: TimeInterval = 5
    static let maxPowAttempts = 3
    static let defaultRetry = 30
    public static let refreshReused = "refresh_reused"
    /// Only these 401 codes mean the access token itself is stale.
    public static let staleToken: Set = ["device_token_invalid", "device_token_expired"]

    private let api: any DeviceEndpoints
    private let store: any SecretStore
    private let platform: String
    private let clock: @Sendable () -> Date
    private let solver: @Sendable (String, Int) async throws -> String
    private let onState: @Sendable (IdentityState) -> Void

    public private(set) var state = IdentityState() {
        didSet { if state != oldValue { onState(state) } }
    }

    private var token: String?
    private var expiresAt = Date.distantPast
    private var obtaining: Task<Void, any Error>?
    private var refreshTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    /// server_time − local time from the last identity response, for countdowns that follow the server clock.
    public private(set) var serverOffset: TimeInterval = 0

    public init(
        api: any DeviceEndpoints, store: any SecretStore, platform: String, clock: @escaping @Sendable () -> Date = Date.init,
        solver: @escaping @Sendable (String, Int) async throws -> String = { token, difficulty in
            try await Task.detached(priority: .userInitiated) { try ProofOfWork.solve(token: token, difficulty: difficulty) }.value
        },
        onState: @escaping @Sendable (IdentityState) -> Void = { _ in }
    ) {
        self.api = api
        self.store = store
        self.platform = platform
        self.clock = clock
        self.solver = solver
        self.onState = onState
    }

    /// Restores the identity from the stored secret, or creates one. Errors become state, never exceptions.
    public func bootstrap() async {
        retryTask?.cancel()
        retryTask = nil
        if state.status != .ready { state.status = .loading }
        do {
            if current() == nil { try await obtain() }
        } catch {
            onError(error)
        }
    }

    /// Clears the one-time "new identity" notice.
    public func dismissReplaced() { state.replaced = false }

    /// A valid access token, refreshing or creating the identity first when needed.
    public func accessToken() async throws -> String {
        if let t = current() { return t }
        do {
            try await obtain()
            guard let t = token else { throw APIError(status: 0, code: "internal", message: "no token", retryAfterSeconds: nil, body: nil) }
            return t
        } catch {
            onError(error)
            throw error
        }
    }

    /// Runs an authenticated request. When the server says the token is stale it refreshes and retries once; every
    /// other error (including other 401 codes) goes back to the caller.
    public func authorized<T: Sendable>(_ block: @Sendable (String) async throws -> T) async throws -> T {
        let used = try await accessToken()
        do {
            return try await block(used)
        } catch let e as APIError where e.status == 401 && IdentityManager.staleToken.contains(e.code) {
            if token == used { token = nil }
            return try await block(accessToken())
        }
    }

    public func rename(_ displayName: String) async throws -> Device {
        let api = self.api
        let device = try await authorized { try await api.rename(token: $0, displayName: displayName) }
        state.device = device
        return device
    }

    /// `POST /v1/devices/current/reset`: the server revokes this identity and returns a new one.
    public func reset() async throws -> Device {
        let api = self.api
        let session = try await authorized { try await api.reset(token: $0) }
        try await accept(session)
        return session.device
    }

    /// Sign-in, sign-up and Add this device answer with an access token carrying `acct` (and `dl`) for this same device:
    /// the refresh secret does not change.
    public func adoptToken(_ accessToken: String, expiresIn: Int) {
        token = accessToken
        expiresAt = clock().addingTimeInterval(TimeInterval(expiresIn))
        state.claims = TokenClaims.decode(accessToken)
        schedule(TimeInterval(expiresIn))
    }

    /// Sign-out answers with a brand-new anonymous device (docs/API.md §2.4); the old one is revoked.
    public func replaceSession(_ session: DeviceSession) async throws { try await accept(session) }

    private func current() -> String? {
        guard let token, clock() < expiresAt.addingTimeInterval(-IdentityManager.expirySkew) else { return nil }
        return token
    }

    /// One refresh or creation at a time; concurrent callers wait for the same one.
    private func obtain() async throws {
        if let running = obtaining { return try await running.value }
        let task = Task { try await self.obtainOnce() }
        obtaining = task
        defer { obtaining = nil }
        try await task.value
    }

    private func obtainOnce() async throws {
        guard let secret = try await store.read() else { return try await create() }
        let session: DeviceSession
        do {
            session = try await api.refresh(secret: secret)
        } catch let e as APIError where e.status == 401 {
            // The server no longer accepts this identity (reuse detected, expired, or revoked): start over.
            try await drop()
            if e.code == IdentityManager.refreshReused { state.replaced = true }
            return try await create()
        }
        try await accept(session)
    }

    private func create() async throws {
        var pow: PowSolution?
        for _ in 0 ..< IdentityManager.maxPowAttempts {
            do {
                try await accept(api.create(CreateDeviceRequest(platform: platform, transport: "body", pow: pow)))
                return
            } catch let e as APIError where e.status == 428 {
                guard let challenge = e.powChallenge else { throw e }
                state.status = .solvingChallenge
                pow = try await PowSolution(token: challenge.token, solution: solver(challenge.token, challenge.difficulty))
            }
        }
        throw APIError(status: 428, code: "pow_required", message: "proof of work not accepted", retryAfterSeconds: nil, body: nil)
    }

    /// Takes a new session: store the rotated secret first, then use the token.
    private func accept(_ session: DeviceSession) async throws {
        guard let secret = session.refreshSecret else {
            throw APIError(
                status: 502,
                code: "refresh_secret_missing",
                message: "no refresh secret in body",
                retryAfterSeconds: nil,
                body: nil
            )
        }
        try await store.write(secret)
        token = session.accessToken
        expiresAt = clock().addingTimeInterval(TimeInterval(session.expiresIn))
        if let server = IdentityManager.parseDate(session.serverTime) { serverOffset = server.timeIntervalSince(clock()) }
        var s = state
        s.status = .ready
        s.device = session.device
        s.retryAt = nil
        s.errorCode = nil
        s.claims = TokenClaims.decode(session.accessToken)
        state = s
        schedule(TimeInterval(session.expiresIn))
    }

    private func drop() async throws {
        token = nil
        expiresAt = .distantPast
        try await store.clear()
        refreshTask?.cancel()
        refreshTask = nil
        state.device = nil
        state.claims = nil
    }

    private func schedule(_ lifetime: TimeInterval) {
        refreshTask?.cancel()
        let delay = max(IdentityManager.minDelay, lifetime - IdentityManager.refreshMargin)
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            await self?.refreshNow()
        }
    }

    private func refreshNow() async {
        do {
            token = nil
            try await obtain()
        } catch {
            // The next request that needs a token tries again; the state tells the UI.
            onError(error)
        }
    }

    private func onError(_ error: any Error) {
        switch error {
        case is NetworkError:
            state.status = .offline
        case let e as APIError where e.status == 429:
            let wait = TimeInterval(e.retryAfterSeconds ?? IdentityManager.defaultRetry)
            state.status = .rateLimited
            state.retryAt = clock().addingTimeInterval(wait)
            retryTask?.cancel()
            retryTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                if Task.isCancelled { return }
                await self?.bootstrap()
            }
        case let e as APIError:
            state.status = .failed
            state.errorCode = e.code
        default:
            state.status = .failed
            state.errorCode = "internal"
        }
    }

    static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
