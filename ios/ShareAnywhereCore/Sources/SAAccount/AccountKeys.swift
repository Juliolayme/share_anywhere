import Foundation

/// Seals small secrets with a device-bound key: the app's Keychain key (`ThisDeviceOnly`; wrapped by the Secure
/// Enclave where present), a memory key in tests.
public protocol Sealer: Sendable {
    func seal(_ plaintext: [UInt8], aad: [UInt8]) throws -> [UInt8]
    func open(_ blob: [UInt8], aad: [UInt8]) throws -> [UInt8]
    /// Forgets the sealing key (sign-out: a later account gets a fresh key).
    func destroy()
}

/// AES-256-GCM with a key held in memory (tests; the app's Keychain sealer has the same format).
public final class MemorySealer: Sealer, @unchecked Sendable {
    private let lock = NSLock()
    private var key: [UInt8]

    public init(key: [UInt8] = Primitives.random(32)) { self.key = key }

    public func seal(_ plaintext: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        let k = lock.withLockedValue { key }
        let nonce = Primitives.random(Primitives.nonceBytes)
        return try nonce + Primitives.aesGCMSeal(key: k, nonce: nonce, plaintext, aad: aad)
    }

    public func open(_ blob: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        guard blob.count > Primitives.nonceBytes else { throw CryptoError("decrypt_failed") }
        let k = lock.withLockedValue { key }
        return try Primitives.aesGCMOpen(
            key: k,
            nonce: Array(blob.prefix(Primitives.nonceBytes)),
            Array(blob.dropFirst(Primitives.nonceBytes)),
            aad: aad
        )
    }

    public func destroy() { lock.withLockedValue { key = Primitives.random(32) } }
}

extension NSLock {
    func withLockedValue<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

/// Every ADK version and the device wrapping key of the signed-in account, each sealed with an AAD naming what it is
/// (`adk|<v>|<account>`, `device|x25519|<account>`), in one file in Application Support (excluded from backups by the
/// app). Bound to one account: another account's file is erased. Sign-out erases it (as Android's AccountKeyStore).
public actor AccountKeyVault {
    private struct Stored: Codable {
        var account: String
        var adks: [String: String] = [:]
        var device: String?
    }

    private let url: URL
    private let sealer: any Sealer

    public init(url: URL, sealer: any Sealer) {
        self.url = url
        self.sealer = sealer
    }

    private func read() -> Stored? { (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) } }

    private func write(_ s: Stored) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(s).write(to: url, options: [.atomic])
    }

    private func state(_ account: String) throws -> Stored {
        if let s = read(), s.account == account { return s }
        let s = Stored(account: account)
        try write(s)
        return s
    }

    public func clear() {
        try? FileManager.default.removeItem(at: url)
        sealer.destroy()
    }

    public func exists() -> Bool { FileManager.default.fileExists(atPath: url.path) }

    public func store(for account: String) -> any KeyStore { VaultStore(vault: self, account: account) }

    fileprivate func versions(_ account: String) throws -> [Int] { try state(account).adks.keys.compactMap(Int.init).sorted() }

    fileprivate func adk(_ account: String, _ v: Int) throws -> [UInt8] {
        guard let blob = try state(account).adks[String(v)] else { throw CryptoError("not_found", "no ADK version \(v)") }
        return try sealer.open(B64u.decode(blob), aad: Array("adk|\(v)|\(account)".utf8))
    }

    fileprivate func save(_ account: String, _ v: Int, _ adk: [UInt8]) throws {
        var s = try state(account)
        let aad = Array("adk|\(v)|\(account)".utf8)
        if let existing = s.adks[String(v)] {
            let held = try sealer.open(B64u.decode(existing), aad: aad)
            if !Primitives.constantTimeEquals(held, adk) { throw CryptoError("invalid_input", "different bytes for stored version \(v)") }
            return
        }
        s.adks[String(v)] = try B64u.encode(sealer.seal(adk, aad: aad))
        try write(s)
    }

    fileprivate func devicePrivateKey(_ account: String) throws -> [UInt8] {
        var s = try state(account)
        let aad = Array("device|x25519|\(account)".utf8)
        if let d = s.device { return try sealer.open(B64u.decode(d), aad: aad) }
        let priv = Primitives.clamp(Primitives.random(32))
        s.device = try B64u.encode(sealer.seal(priv, aad: aad))
        try write(s)
        return priv
    }
}

private struct VaultStore: KeyStore {
    let vault: AccountKeyVault
    let account: String
    func versions() async throws -> [Int] { try await vault.versions(account) }
    func adk(_ v: Int) async throws -> [UInt8] { try await vault.adk(account, v) }
    func save(_ v: Int, _ adk: [UInt8]) async throws { try await vault.save(account, v, adk) }
    func devicePrivateKey() async throws -> [UInt8] { try await vault.devicePrivateKey(account) }
    func clear() async throws { await vault.clear() }
}

/// Devices this device revoked (`<id>@<version>`, §1.8 Remembered exclusions) and the account they belong to.
public actor SyncMeta {
    private struct Meta: Codable {
        var owner: String?
        var excluded: [String] = []
    }

    private let url: URL
    public init(url: URL) { self.url = url }

    private func read() -> Meta { (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Meta.self, from: $0) } ?? Meta() }

    private func write(_ m: Meta) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(m).write(to: url, options: [.atomic])
    }

    public func owner() -> String? { read().owner }

    public func setOwner(_ id: String) throws {
        var m = read()
        m.owner = id
        try write(m)
    }

    public func excluded() -> [(id: String, version: Int)] {
        read().excluded.map { raw in
            if let at = raw.lastIndex(of: "@"), at > raw.startIndex, let v = Int(raw[raw.index(after: at)...]) {
                return (String(raw[..<at]).lowercased(), v)
            }
            return (raw.lowercased(), 0)
        }
    }

    public func setExcluded(_ list: [(id: String, version: Int)]) throws {
        var order: [String] = []
        var byID: [String: Int] = [:]
        for (id, v) in list {
            if byID[id] == nil { order.append(id) }
            byID[id] = max(byID[id] ?? 0, v)
        }
        var m = read()
        m.excluded = order.map { "\($0)@\(byID[$0] ?? 0)" }
        try write(m)
    }

    public func wipe() { try? FileManager.default.removeItem(at: url) }
}

public enum KeyStatus: String, Sendable, Equatable { case none, checking, setup, pair, ready, error, rejected, refused, legacy }

public struct KeyCheck: Sendable {
    public var status: KeyStatus
    public var keyVersion: Int
    public var state: KeysState?
    public var newVersions: [Int]
    public var rotationOwed: Bool
}

public struct KeyStateError: Error, Equatable {
    public let status: KeyStatus
}

/// Key state from the server's newest version and the newest version held here.
public func deriveKeyStatus(server: Int, local: Int) -> KeyStatus {
    if server <= 0 { return .setup }
    return local >= server ? .ready : .pair
}

/// The key steps of an added device (docs/CLIPBOARD_PROTOCOL.md §1.8), the Swift twin of the Web's keyFlow.ts and
/// Android's `AccountKeys`: key check (pickup, re-proof, chain import, owed rotation), rotation after a revoke with
/// remembered exclusions, pairing both ways, recovery and setup. Calls run one at a time.
public actor AccountKeys {
    private let api: any AccountEndpoints
    private let vault: AccountKeyVault
    private let meta: SyncMeta
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(api: any AccountEndpoints, vault: AccountKeyVault, meta: SyncMeta) {
        self.api = api
        self.vault = vault
        self.meta = meta
    }

    /// One flow at a time (the actor is reentrant across awaits).
    private func serial<T: Sendable>(_ body: () async throws -> T) async rethrows -> T {
        while busy {
            await withCheckedContinuation { waiters.append($0) }
        }
        busy = true
        defer {
            busy = false
            if !waiters.isEmpty { waiters.removeFirst().resume() }
        }
        return try await body()
    }

    public func store(_ account: String) async -> any KeyStore { await vault.store(for: account) }

    private static func apiCode(_ e: any Error, _ codes: String...) -> Bool {
        guard let a = e as? APIError else { return false }
        return codes.contains(a.code)
    }

    public func check(account: String, device: String) async throws -> KeyCheck {
        try await serial { try await checkAndRotate(account, device) }
    }

    private func checkAndRotate(_ account: String, _ device: String) async throws -> KeyCheck {
        let check = try await checkNow(account, device)
        if check.status != .ready || check.state?.rotationDue != true { return check }
        do {
            _ = try await rotateNow(account, device, exclude: [], owed: true)
        } catch let e as KeyStateError where e.status == .pair {
            // fall through: the device needs pairing first
        } catch {
            if let status = AccountKeys.rotationErrorStatus(error) {
                var c = check
                c.status = status
                c.rotationOwed = false
                return c
            }
            var c = check
            c.rotationOwed = true
            return c
        }
        var after = try await checkNow(account, device)
        after.newVersions = check.newVersions + after.newVersions
        return after
    }

    public static func rotationErrorStatus(_ e: any Error) -> KeyStatus? {
        if let k = e as? KeyStateError { return k.status == .pair ? nil : k.status }
        if apiCode(e, "rotation_unauthorized", "device_key_unproven", "key_version_conflict") { return .refused }
        if apiCode(e, "keys_legacy") || (e as? CryptoError)?.code == "keys_legacy" { return .legacy }
        if (e as? CryptoError)?.code == "unverified" { return .rejected }
        return nil
    }

    private func importOlder(_ store: any KeyStore, chain: KeyChain? = nil) async throws -> [Int] {
        let local = try await store.current()
        if local < 2 { return [] }
        if try await store.versions().count >= local { return [] }
        let c = if let chain { chain } else { try await api.chain() }
        return try await KeyFlows.importChain(store, c)
    }

    private func checkNow(_ account: String, _ device: String) async throws -> KeyCheck {
        // Keys left behind by another account are never reused.
        if let owner = await meta.owner(), owner != account {
            await vault.clear()
            await meta.wipe()
        }
        let store = await vault.store(for: account)
        let pub = try await B64u.encode(Primitives.x25519PublicKey(store.devicePrivateKey()))
        var state = try await api.keys()
        try await meta.setOwner(account)
        let held = try await store.current()
        if held > 0, state.keyVersion < held {
            return KeyCheck(status: .rejected, keyVersion: state.keyVersion, state: state, newVersions: [], rotationOwed: false)
        }
        var newVersions: [Int] = []
        var rejected = false, legacyFound = false, refused = false
        var chain: KeyChain?
        for attempt in 0 ..< 2 {
            if !state.pending.isEmpty {
                let c = try await api.chain()
                chain = c
                let res = try await KeyFlows.acceptPendingBlobs(store, pending: state.pending, chain: c)
                for v in res.accepted {
                    try? await api.ackPending(v)
                }
                newVersions += res.accepted
                if res.failed.contains(where: { $0.code == "unverified" }) { rejected = true }
                if res.failed.contains(where: { $0.code == "keys_legacy" }) { legacyFound = true }
            }
            let newest = try await store.current()
            let mine = state.devices.first { $0.deviceId.lowercased() == device.lowercased() }
            let stale = mine?.publicKey != pub || mine?.proof == nil || (mine?.keyVersion ?? 0) < newest
            if newest == 0 || !stale { break }
            let registration = try await KeyFlows.proveDeviceKey(store, deviceID: device)
            do {
                try await api.registerKey(registration)
                state = try await api.keys()
                break
            } catch let e as APIError {
                if e.code == "key_version_conflict", attempt == 0 {
                    state = try await api.keys()
                    continue
                }
                switch e.code {
                case "keys_legacy": legacyFound = true
                case "key_version_conflict":
                    state = try await api.keys()
                    if try await state.keyVersion <= store.current() { refused = true }
                case "device_key_unproven": refused = true
                default: throw e
                }
                break
            }
        }
        var status = try await deriveKeyStatus(server: state.keyVersion, local: store.current())
        if legacyFound {
            status = .legacy
        } else if rejected {
            status = .rejected
        } else if refused {
            status = .refused
        } else if status == .ready {
            newVersions += try await importOlder(store, chain: chain)
        }
        return KeyCheck(status: status, keyVersion: state.keyVersion, state: state, newVersions: newVersions, rotationOwed: false)
    }

    /// Before `DELETE /v1/devices/{id}`: remember the device at the account's current version (fail closed).
    public func rememberRevoked(account: String, ids: [String]) async throws {
        if ids.isEmpty { return }
        let local = await (try? vault.store(for: account).current()) ?? 0
        let v = try await max(local, api.keys().keyVersion)
        try await meta.setExcluded(meta.excluded() + ids.map { (id: $0.lowercased(), version: v) })
    }

    public func forgetRevoked(_ ids: [String]) async throws {
        let drop = Set(ids.map { $0.lowercased() })
        try await meta.setExcluded(meta.excluded().filter { !drop.contains($0.id) })
    }

    private func pruneRemembered(_ store: any KeyStore, _ state: KeysState) async throws {
        let list = await meta.excluded()
        if list.isEmpty { return }
        var keep: [(id: String, version: Int)] = []
        for (id, v) in list {
            let d = state.devices.first { $0.deviceId.lowercased() == id }
            guard let d, let pub = d.publicKey else {
                if state.keyVersion <= v { keep.append((id, v)) }
                continue
            }
            if let kv = d.keyVersion, kv > v, let proof = d.proof, try await store.has(kv) {
                let raw = try await store.adk(kv)
                if try Verify.checkDeviceKeyProof(
                    verifyKey: Authenticity.verifyKey(raw),
                    deviceID: d.deviceId,
                    kv,
                    publicKey: pub,
                    proof: proof
                ) {
                    continue
                }
            }
            keep.append((id, v))
        }
        if keep.count != list.count { try await meta.setExcluded(keep) }
    }

    /// Rotation after revoking `exclude` (or one that is owed): returns true when a rotation was made.
    public func rotate(account: String, device: String, exclude: [String]) async throws -> Bool {
        try await serial {
            try? await rememberRevoked(account: account, ids: exclude)
            return try await rotateNow(account, device, exclude: exclude, owed: false)
        }
    }

    private func rotateNow(_ account: String, _ device: String, exclude: [String], owed: Bool) async throws -> Bool {
        let store = await vault.store(for: account)
        let first = try await checkNow(account, device)
        if first.status == .ready, let s = first.state { try? await pruneRemembered(store, s) }
        var excluded: [String] = []
        for id in await exclude.map({ $0.lowercased() }) + (meta.excluded()).map(\.id) where !excluded.contains(id) {
            excluded.append(id)
        }
        var conflictedFrom: Int?
        var attempt = 0
        while true {
            let check = try await checkNow(account, device)
            guard let state = check.state else { throw KeyStateError(status: .error) }
            if state.keyVersion == 0 || (owed && !state.rotationDue) { return false }
            guard let recovery = state.recovery else { throw KeyStateError(status: .rejected) }
            if let from = conflictedFrom, state.keyVersion > from, !state.rotationDue { return true }
            if [.rejected, .refused, .legacy].contains(check.status) { throw KeyStateError(status: check.status) }
            if check.status != .ready { throw KeyStateError(status: .pair) }
            let prep = try await KeyFlows.prepareRotation(
                store, serverKeyVersion: state.keyVersion, recovery: recovery, devices: state.devices, exclude: excluded
            )
            do {
                _ = try await api.rotate(prep.request)
            } catch let e as APIError {
                prep.discard()
                if attempt == 0, e.code == "devices_changed" || e.code == "key_version_conflict" {
                    if e.code == "key_version_conflict" { conflictedFrom = state.keyVersion }
                    if e.code == "devices_changed" { try await completeRevokes(excluded, e, explicit: exclude) }
                    attempt += 1
                    continue
                }
                throw e
            }
            try await prep.commit(store)
            try? await api.ackPending(prep.request.keyVersion)
            try? await forgetRevoked(excluded)
            return true
        }
    }

    /// A remembered revoke the server did not apply: send it again and keep the device excluded (never re-included).
    private func completeRevokes(_ excluded: [String], _ e: APIError, explicit: [String]) async throws {
        var missing: [String] = []
        if case let .array(items)? = e.body?["missing"] {
            for case let .string(s) in items {
                missing.append(s.lowercased())
            }
        }
        let keep = Set(explicit.map { $0.lowercased() })
        let candidates = missing.filter { excluded.contains($0) && !keep.contains($0) }
        if candidates.isEmpty { return }
        let present = try await Set(api.devices().map { $0.id.lowercased() })
        for id in candidates where present.contains(id) {
            do { try await api.revokeDevice(id) } catch let x as APIError where x.status == 404 {}
        }
    }

    // MARK: Setup, pairing, recovery

    public func prepareSetup(account: String) async throws -> KeyFlows.PreparedSetup {
        try await KeyFlows.prepareSetup(vault.store(for: account))
    }

    public struct PairingStart: Sendable {
        public let ephemeralPrivate: [UInt8]
        public let pairingID: String
        public let payload: String
        public let expiresAt: String
    }

    /// On this (new) device: an ephemeral key, a pairing code and the QR payload `sa1.<code>.<fingerprint>`.
    public func startPairing() async throws -> PairingStart {
        let priv = Primitives.clamp(Primitives.random(32))
        let pub = try B64u.encode(Primitives.x25519PublicKey(priv))
        let p = try await api.createPairing(ephemeralPublicKey: pub)
        return try PairingStart(
            ephemeralPrivate: priv,
            pairingID: p.pairingId,
            payload: KeyFlows.pairingPayload(code: p.code, ephemeralPublicKey: pub),
            expiresAt: p.expiresAt
        )
    }

    public func finishPairing(account: String, start: PairingStart, ready: PairingStatus) async throws -> Int {
        try await serial {
            let store = await vault.store(for: account)
            let state = try await api.keys()
            let chain = try await api.chain()
            let v = try await KeyFlows.acceptPairing(
                store, ephemeralPrivate: start.ephemeralPrivate, ready: ready, chain: chain,
                trustedSenderKeys: state.devices.map(\.publicKey)
            )
            _ = try await importOlder(store, chain: chain)
            return v
        }
    }

    public func recover(account: String, phrase: String) async throws -> Int {
        try await serial {
            let store = await vault.store(for: account)
            let rec = try await api.recovery()
            let chain = try await api.chain()
            let state = try await api.keys()
            let v = try await KeyFlows.recover(store, phrase: phrase, response: rec, chain: chain, recoveryKey: state.recovery)
            _ = try await importOlder(store, chain: chain)
            return v
        }
    }

    public struct CodeLookup: Sendable {
        public let code: String
        public let fingerprint: String
        public let peer: PairingPeer
    }

    /// The existing device reads a scanned or pasted pairing payload; nil when it is not one.
    public func lookupCode(_ text: String) async throws -> CodeLookup? {
        guard let (code, fp) = KeyFlows.parsePairingPayload(text) else { return nil }
        return try await CodeLookup(code: code, fingerprint: fp, peer: api.lookupPairing(code))
    }

    /// Sends this device's newest ADK to the device that showed the code (after the fingerprint check).
    public func sendKey(account: String, device: String, to found: CodeLookup) async throws {
        var attempt = 0
        while true {
            let req = try await KeyFlows.wrapForPairing(
                vault.store(for: account),
                ephemeralPublicKey: found.peer.ephemeralPublicKey,
                fingerprint: found.fingerprint
            )
            do {
                try await api.wrapPairing(found.code, req)
                return
            } catch let e as APIError where attempt == 0 && (e.code == "key_version_conflict" || e.code == "device_key_unproven") {
                _ = try await check(account: account, device: device)
                attempt += 1
            }
        }
    }

    /// Something of an account is still on the device (keys or key bookkeeping).
    public func leftover() async -> Bool {
        let keys = await vault.exists()
        let owner = await meta.owner()
        let excluded = await meta.excluded()
        return keys || owner != nil || !excluded.isEmpty
    }

    /// Everything this device keeps for the account (sign-out, another account, the session ended).
    public func wipe() async {
        await vault.clear()
        await meta.wipe()
    }
}
