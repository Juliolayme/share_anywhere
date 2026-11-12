import Foundation
@_exported import SAAPIClient
@_exported import SAClipboardCrypto

/// Where a device keeps its account keys (docs/CLIPBOARD_PROTOCOL.md §1.9): every ADK version it holds and its X25519
/// device wrapping key. The app seals both with a Keychain key (`ThisDeviceOnly`); tests use memory.
public protocol KeyStore: Sendable {
    func versions() async throws -> [Int]
    /// A copy of ADK(v).
    func adk(_ v: Int) async throws -> [UInt8]
    /// Stores ADK(v); the same bytes again are a no-op, different bytes for a stored version are refused.
    func save(_ v: Int, _ adk: [UInt8]) async throws
    /// The device wrapping private key, created on first use.
    func devicePrivateKey() async throws -> [UInt8]
    func clear() async throws
}

public extension KeyStore {
    func current() async throws -> Int { try await versions().max() ?? 0 }
    func has(_ v: Int) async throws -> Bool { try await versions().contains(v) }
}

/// A key store in memory (tests, and the in-process cache of the sealed store).
public actor MemoryKeyStore: KeyStore {
    private var adks: [Int: [UInt8]] = [:]
    private var device: [UInt8]?

    public init() {}

    public func versions() -> [Int] { adks.keys.sorted() }

    public func adk(_ v: Int) throws -> [UInt8] {
        guard let a = adks[v] else { throw CryptoError("not_found", "no ADK version \(v)") }
        return a
    }

    public func save(_ v: Int, _ adk: [UInt8]) throws {
        if let existing = adks[v] {
            if !Primitives
                .constantTimeEquals(existing, adk) { throw CryptoError("invalid_input", "different bytes for stored version \(v)") }
            return
        }
        adks[v] = adk
    }

    public func devicePrivateKey() -> [UInt8] {
        if let device { return device }
        let d = Primitives.clamp(Primitives.random(32))
        device = d
        return d
    }

    public func clear() {
        adks.removeAll()
        device = nil
    }

    /// Restores a snapshot (the sealed store loads into memory).
    public func load(adks: [Int: [UInt8]], device: [UInt8]?) {
        self.adks = adks
        self.device = device
    }

    public func snapshot() -> (adks: [Int: [UInt8]], device: [UInt8]?) { (adks, device) }
}

/// `GET /v1/keys/chain`: chain links (for version v, ADK(v-1) wrapped with ADK(v)) and every version's verify key.
public struct KeyChain: Codable, Sendable, Equatable {
    public var chain: [ChainLink]
    public var versions: [KeyVersionInfo]
    public init(chain: [ChainLink], versions: [KeyVersionInfo]) {
        self.chain = chain
        self.versions = versions
    }
}

/// `PUT /v1/keys/device`.
public struct DeviceKeyRequest: Codable, Sendable, Equatable {
    public var publicKey: String
    public var keyVersion: Int
    public var proof: String
    enum CodingKeys: String, CodingKey { case publicKey = "public_key", keyVersion = "key_version", proof }
}

func unverified(_ m: String) -> CryptoError { CryptoError("unverified", m) }
func legacy() -> CryptoError { CryptoError("keys_legacy", "the account keys predate key authenticity and must be set up again") }

/// The client rules of §1.13, the Swift twin of the Web's authenticity.ts and Android's `Verify`.
public enum Verify {
    public static func versionVerifyKey(_ versions: [KeyVersionInfo], _ v: Int) throws -> [UInt8] {
        guard let row = versions.first(where: { $0.keyVersion == v }) else { throw unverified("no verify key for version \(v)") }
        guard let key = row.verifyKey else { throw legacy() }
        guard let bytes = try? B64u.decode(key), bytes.count == 32 else { throw unverified("malformed verify key for version \(v)") }
        return bytes
    }

    static func chainBlob(_ state: KeyChain, _ v: Int) throws -> [UInt8] {
        guard let link = state.chain.first(where: { $0.keyVersion == v }) else { throw unverified("no chain link for version \(v)") }
        guard let b = try? B64u.decode(link.blob) else { throw unverified("malformed chain link for version \(v)") }
        return b
    }

    /// Rotations fromVersion+1...upTo are each signed by the version before them, starting from `fromKey` (or verify_key(1)).
    public static func verifySignatureChain(_ state: KeyChain, upTo: Int, fromVersion: Int = 1, fromKey: [UInt8]? = nil) throws {
        if upTo < 1 || fromVersion < 1 { throw CryptoError("invalid_input", "key version") }
        if fromVersion > upTo { throw unverified("version \(upTo) is older than the held version \(fromVersion)") }
        var previous = try fromKey ?? versionVerifyKey(state.versions, 1)
        if fromVersion + 1 > upTo { return }
        for k in fromVersion + 1 ... upTo {
            let current = try versionVerifyKey(state.versions, k)
            let row = state.versions.first { $0.keyVersion == k }
            guard let sig = row?.signature else {
                if let row, row.verifyKey != nil { throw legacy() }
                throw unverified("version \(k) is unsigned")
            }
            guard let signature = try? B64u.decode(sig) else { throw unverified("malformed signature for version \(k)") }
            let message = try Authenticity.rotationMessage(keyVersion: k, verifyKey: current, chainBlob: chainBlob(state, k))
            if !Authenticity.verify(signature: signature, message, verifyKey: previous) {
                throw unverified("version \(k) is not signed by version \(k - 1)")
            }
            previous = current
        }
    }

    public static func assertAdkMatchesVersion(_ adk: [UInt8], _ versions: [KeyVersionInfo], _ v: Int) throws {
        if try !Primitives.constantTimeEquals(Authenticity.verifyKey(adk), versionVerifyKey(versions, v)) {
            throw unverified("ADK version \(v) does not match the account's verify key")
        }
    }

    /// Anchors a server-supplied account on the keys held here before a received ADK(v) is stored (F.1).
    public static func assertAnchoredOnHeld(_ store: any KeyStore, _ state: KeyChain, _ v: Int, _ received: [UInt8]) async throws {
        let held = try await store.versions()
        guard let k = held.max() else { return }
        if v < k { throw unverified("version \(v) is older than the held version \(k)") }
        var topVerifyKey: [UInt8]?
        var heldTop: [UInt8]?
        for h in held {
            let raw = try await store.adk(h)
            let own = try Authenticity.verifyKey(raw)
            if try !Primitives.constantTimeEquals(own, versionVerifyKey(state.versions, h)) {
                throw unverified("held ADK version \(h) does not match the account's verify key")
            }
            if h == k {
                topVerifyKey = own
                heldTop = raw
            }
        }
        guard let topVerifyKey, let heldTop else { throw unverified("held ADK version \(k) is missing") }
        try verifySignatureChain(state, upTo: v, fromVersion: k, fromKey: topVerifyKey)
        var walked = received
        var j = v
        while j > k {
            do {
                walked = try Wrap.unwrapChain(chainBlob(state, j), newer: walked, keyVersion: j)
            } catch let e as CryptoError where e.code == "unverified" {
                throw e
            } catch {
                throw unverified("chain link \(j) does not open toward the held key")
            }
            j -= 1
        }
        if !Primitives.constantTimeEquals(walked, heldTop) { throw unverified("the received key does not lead to held version \(k)") }
    }

    /// Rotation pickup (A.6): chain link v opened with the candidate yields the held ADK(v-1), and the candidate derives verify_key(v).
    public static func assertRotationLink(_ candidate: [UInt8], heldPrevious: [UInt8], _ state: KeyChain, _ v: Int) throws {
        if v < 2 { throw unverified("a rotation exists only for key_version >= 2") }
        let opened: [UInt8]
        do {
            opened = try Wrap.unwrapChain(chainBlob(state, v), newer: candidate, keyVersion: v)
        } catch let e as CryptoError where e.code == "unverified" {
            throw e
        } catch {
            throw unverified("chain link \(v) does not open with the new key")
        }
        if !Primitives.constantTimeEquals(opened, heldPrevious) { throw unverified("chain link \(v) does not lead to the held key") }
        try assertAdkMatchesVersion(candidate, state.versions, v)
    }

    /// The recovery public key is signed by ADK v1 (ADR 0015); nil is a legacy account.
    public static func assertRecoveryKeySigned(_ recoveryPublicKey: String, _ signature: String?, verifyKeyV1: [UInt8]) throws {
        guard let signature else { throw legacy() }
        let ok = (try? Authenticity.verify(
            signature: B64u.decode(signature), Authenticity.recoveryKeyMessage(B64u.decode(recoveryPublicKey)), verifyKey: verifyKeyV1
        )) ?? false
        if !ok { throw unverified("the recovery key is not signed by version 1") }
    }

    public static func deviceKeyProof(_ adk: [UInt8], _ v: Int, deviceID: String, publicKey: [UInt8]) throws -> DeviceKeyRequest {
        try DeviceKeyRequest(
            publicKey: B64u.encode(publicKey), keyVersion: v,
            proof: B64u.encode(Authenticity.sign(
                adk,
                Authenticity.deviceKeyMessage(deviceID: deviceID, keyVersion: v, publicKey: publicKey)
            ))
        )
    }

    public static func checkDeviceKeyProof(verifyKey: [UInt8], deviceID: String, _ v: Int, publicKey: String, proof: String) -> Bool {
        (try? Authenticity.verify(
            signature: B64u.decode(proof),
            Authenticity.deviceKeyMessage(deviceID: deviceID, keyVersion: v, publicKey: B64u.decode(publicKey)), verifyKey: verifyKey
        )) ?? false
    }
}

/// Key flows (§1.8), the Swift twins of the Web's bootstrap.ts, pairing.ts and rotation.ts and Android's `KeyFlows`.
public enum KeyFlows {
    public static let defaultArgon = Primitives.ArgonParams(m: 65536, t: 3, p: 1)
    public static let pairingPrefix = "sa1"

    /// A setup ready to post; `commit` stores ADK v1 only after the server accepted it (§1.8 Setup).
    public final class PreparedSetup: @unchecked Sendable {
        public let request: KeysSetupRequest
        public let phrase: String
        private var adk: [UInt8]?

        init(request: KeysSetupRequest, phrase: String, adk: [UInt8]) {
            self.request = request
            self.phrase = phrase
            self.adk = adk
        }

        public func commit(_ store: any KeyStore) async throws {
            guard let a = adk else { throw CryptoError("invalid_input", "setup already committed or discarded") }
            adk = nil
            try await store.save(1, a)
        }

        public func discard() { adk = nil }
    }

    public static func prepareSetup(_ store: any KeyStore, params: Primitives.ArgonParams = defaultArgon) async throws -> PreparedSetup {
        if try await store.current() != 0 { throw CryptoError("invalid_input", "this device already holds an ADK") }
        let phrase = Phrase.generate()
        let salt = Primitives.random(16)
        let rec = try Recovery.derive(phrase: phrase, salt: salt, params: params)
        let adk = Primitives.random(32)
        let anchorKey = Authenticity.anchorKey(rec.seed)
        let verifyKey = try Authenticity.verifyKey(adk)
        let request = try KeysSetupRequest(
            recoveryPublicKey: B64u.encode(rec.publicKey), salt: B64u.encode(salt),
            params: Argon2Spec(m: params.m, t: params.t, p: params.p),
            recoveryBlob: B64u.encode(Wrap.wrap(
                adk: adk,
                senderPrivate: Primitives.random(32),
                recipientPublic: rec.publicKey,
                purpose: "recovery",
                keyVersion: 1
            )),
            verifyKey: B64u.encode(verifyKey),
            recoveryAnchor: B64u.encode(Authenticity.recoveryAnchor(anchorKey: anchorKey, verifyKeyV1: verifyKey)),
            recoveryKeySignature: B64u.encode(Authenticity.sign(adk, Authenticity.recoveryKeyMessage(rec.publicKey)))
        )
        return PreparedSetup(request: request, phrase: phrase, adk: adk)
    }

    /// Recovery with the phrase, fully anchored (§1.13 Recovery). Returns the stored version.
    public static func recover(
        _ store: any KeyStore, phrase: String, response: RecoveryBlob, chain: KeyChain, recoveryKey: RecoveryInfo?
    ) async throws -> Int {
        let v = response.keyVersion
        if v < 1 { throw CryptoError("invalid_input", "key version") }
        let salt = try B64u.decode(response.salt)
        let rec = try Recovery.derive(
            phrase: phrase, salt: salt, params: Primitives.ArgonParams(m: response.params.m, t: response.params.t, p: response.params.p)
        )
        let anchorKey = Authenticity.anchorKey(rec.seed)
        let raw = try Wrap.unwrap(B64u.decode(response.recoveryBlob), recipientPrivate: rec.privateKey, purpose: "recovery", keyVersion: v)
        guard let anchor = response.recoveryAnchor else { throw CryptoError("keys_legacy", "this account has no recovery anchor") }
        do {
            let verifyKeyV1 = try Verify.versionVerifyKey(chain.versions, 1)
            if try !Primitives.constantTimeEquals(
                Authenticity.recoveryAnchor(anchorKey: anchorKey, verifyKeyV1: verifyKeyV1),
                B64u.decode(anchor)
            ) {
                throw CryptoError("recovery_unverified", "the recovery anchor does not match the first verify key")
            }
            guard let recoveryKey, try Primitives.constantTimeEquals(rec.publicKey, B64u.decode(recoveryKey.publicKey)) else {
                throw CryptoError("recovery_unverified", "the account lists another recovery key than this phrase derives")
            }
            try Verify.assertRecoveryKeySigned(recoveryKey.publicKey, recoveryKey.signature, verifyKeyV1: verifyKeyV1)
            try Verify.verifySignatureChain(chain, upTo: v)
            try Verify.assertAdkMatchesVersion(raw, chain.versions, v)
            try await Verify.assertAnchoredOnHeld(store, chain, v, raw)
        } catch let e as CryptoError where e.code == "keys_legacy" || e.code == "recovery_unverified" {
            throw e
        } catch {
            throw CryptoError("recovery_unverified", "the recovered key does not verify against the account")
        }
        try await store.save(v, raw)
        return v
    }

    // MARK: Pairing (§1.8)

    public static func pairingFingerprint(_ ephemeralPublicKey: String) throws -> String {
        let pub = try B64u.decode(ephemeralPublicKey)
        if pub.count != 32 { throw CryptoError("invalid_input", "ephemeral public key must be 32 bytes") }
        return B64u.encode(Array(Primitives.sha256(pub).prefix(16)))
    }

    public static func pairingPayload(code: String, ephemeralPublicKey: String) throws -> String {
        guard !code.isEmpty, !code.contains(where: \.isWhitespace) else { throw CryptoError("invalid_input", "pairing code") }
        return try "\(pairingPrefix).\(code).\(pairingFingerprint(ephemeralPublicKey))"
    }

    /// `sa1.<code>.<fingerprint>` from a scanned QR or pasted text, or nil.
    public static func parsePairingPayload(_ text: String) -> (code: String, fingerprint: String)? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = t.firstIndex(of: "."), let last = t.lastIndex(of: "."), last > first,
              t[..<first] == pairingPrefix else { return nil }
        let code = String(t[t.index(after: first) ..< last])
        let fp = String(t[t.index(after: last)...])
        if code.isEmpty || code.contains(where: \.isWhitespace) { return nil }
        guard let bytes = try? B64u.decode(fp), bytes.count == 16 else { return nil }
        return (code, fp)
    }

    /// The existing device wraps its newest ADK to the new device's ephemeral key, after the fingerprint check.
    public static func wrapForPairing(
        _ store: any KeyStore,
        ephemeralPublicKey: String,
        fingerprint: String
    ) async throws -> PairingWrapRequest {
        if try !Primitives.constantTimeEquals(B64u.decode(pairingFingerprint(ephemeralPublicKey)), B64u.decode(fingerprint)) {
            throw CryptoError("untrusted_sender", "pairing key does not match the scanned code")
        }
        let v = try await store.current()
        if v == 0 { throw CryptoError("not_found", "this device holds no ADK to share") }
        let raw = try await store.adk(v)
        let devicePrivate = try await store.devicePrivateKey()
        let blob = try Wrap.wrap(
            adk: raw,
            senderPrivate: devicePrivate,
            recipientPublic: B64u.decode(ephemeralPublicKey),
            purpose: "pair",
            keyVersion: v
        )
        return try PairingWrapRequest(
            keyVersion: v,
            senderPublicKey: B64u.encode(Primitives.x25519PublicKey(devicePrivate)),
            blob: B64u.encode(blob)
        )
    }

    /// The new device accepts the pairing blob (§1.13 Pairing receive).
    public static func acceptPairing(
        _ store: any KeyStore, ephemeralPrivate: [UInt8], ready: PairingStatus, chain: KeyChain, trustedSenderKeys: [String?]
    ) async throws -> Int {
        guard let v = ready.keyVersion else { throw CryptoError("invalid_input", "no key version") }
        guard let senderKey = ready.senderPublicKey else { throw CryptoError("invalid_input", "no sender key") }
        guard let blobText = ready.blob else { throw CryptoError("invalid_input", "no blob") }
        if !trustedSenderKeys
            .contains(senderKey) { throw CryptoError("untrusted_sender", "pairing sender is not a device of this account") }
        let blob = try B64u.decode(blobText)
        if try !Primitives.constantTimeEquals(Wrap.senderPublicKey(blob), B64u.decode(senderKey)) {
            throw CryptoError("untrusted_sender", "the blob is not wrapped by the named sender")
        }
        let raw = try Wrap.unwrap(blob, recipientPrivate: ephemeralPrivate, purpose: "pair", keyVersion: v)
        try Verify.assertAdkMatchesVersion(raw, chain.versions, v)
        if try await store.current() > 0 {
            try await Verify.assertAnchoredOnHeld(store, chain, v, raw)
        } else {
            try Verify.verifySignatureChain(chain, upTo: v)
        }
        try await store.save(v, raw)
        return v
    }

    // MARK: Device key, pickup, chain import, rotation

    /// Registration of this device's wrapping key, proven by the newest version held (§1.7).
    public static func proveDeviceKey(_ store: any KeyStore, deviceID: String) async throws -> DeviceKeyRequest {
        let v = try await store.current()
        if v == 0 { throw CryptoError("not_found", "no ADK to prove the device key with") }
        let raw = try await store.adk(v)
        let priv = try await store.devicePrivateKey()
        return try Verify.deviceKeyProof(raw, v, deviceID: deviceID.lowercased(), publicKey: Primitives.x25519PublicKey(priv))
    }

    public struct PendingResult: Sendable, Equatable {
        public var accepted: [Int]
        public var failed: [Failure]
        public struct Failure: Sendable, Equatable {
            public var keyVersion: Int
            public var code: String
        }
    }

    public static func acceptPendingBlobs(_ store: any KeyStore, pending: [PendingBlob], chain: KeyChain) async throws -> PendingResult {
        var result = PendingResult(accepted: [], failed: [])
        for p in pending.sorted(by: { $0.keyVersion < $1.keyVersion }) {
            do {
                let priv = try await store.devicePrivateKey()
                if p.keyVersion < 2 { throw unverified("a rotation blob exists only for key_version >= 2") }
                if try await !store.has(p.keyVersion - 1) { throw CryptoError(
                    "not_found",
                    "this device lacks ADK version \(p.keyVersion - 1)"
                ) }
                let raw = try Wrap.unwrap(B64u.decode(p.blob), recipientPrivate: priv, purpose: "rotate", keyVersion: p.keyVersion)
                let held = try await store.adk(p.keyVersion - 1)
                try Verify.assertRotationLink(raw, heldPrevious: held, chain, p.keyVersion)
                try await store.save(p.keyVersion, raw)
                result.accepted.append(p.keyVersion)
            } catch let e as CryptoError {
                result.failed.append(.init(keyVersion: p.keyVersion, code: e.code))
            }
        }
        return result
    }

    /// Walks down from the newest held ADK, verifying each older key (§1.13 Chain import).
    public static func importChain(_ store: any KeyStore, _ state: KeyChain) async throws -> [Int] {
        var added: [Int] = []
        var v = try await store.current()
        while v >= 2 {
            if try await store.has(v - 1) {
                v -= 1
                continue
            }
            guard let blob = state.chain.first(where: { $0.keyVersion == v })?.blob else { break }
            let raw = try await store.adk(v)
            guard let link = try? B64u.decode(blob) else { throw unverified("malformed chain link for version \(v)") }
            let previous = try Wrap.unwrapChain(link, newer: raw, keyVersion: v)
            if try !Primitives.constantTimeEquals(Authenticity.verifyKey(previous), Verify.versionVerifyKey(state.versions, v - 1)) {
                throw unverified("ADK version \(v - 1) from the chain does not match the account's verify key")
            }
            let row = state.versions.first { $0.keyVersion == v }
            guard let sig = row?.signature else { throw row != nil ? legacy() : unverified("version \(v) is unsigned") }
            let message = try Authenticity.rotationMessage(
                keyVersion: v,
                verifyKey: Verify.versionVerifyKey(state.versions, v),
                chainBlob: link
            )
            if try !Authenticity.verify(signature: B64u.decode(sig), message, verifyKey: Authenticity.verifyKey(previous)) {
                throw unverified("version \(v) is not signed by version \(v - 1)")
            }
            try await store.save(v - 1, previous)
            added.append(v - 1)
            v -= 1
        }
        return added
    }

    public enum Skip: String, Sendable { case noKey, unproven, stale, excluded }

    public final class PreparedRotation: @unchecked Sendable {
        public let request: KeysRotateRequest
        public let skipped: [(deviceID: String, reason: Skip)]
        private var next: [UInt8]?
        private let version: Int

        init(request: KeysRotateRequest, skipped: [(String, Skip)], next: [UInt8], version: Int) {
            self.request = request
            self.skipped = skipped.map { (deviceID: $0.0, reason: $0.1) }
            self.next = next
            self.version = version
        }

        public func commit(_ store: any KeyStore) async throws {
            guard let n = next else { throw CryptoError("invalid_input", "rotation already committed or discarded") }
            next = nil
            try await store.save(version, n)
        }

        public func discard() { next = nil }
    }

    static func skipReason(_ d: DeviceKey, _ v: Int, verifyKey: [UInt8], exclude: Set<String>) -> Skip? {
        if exclude.contains(d.deviceId.lowercased()) { return .excluded }
        guard let pub = d.publicKey else { return .noKey }
        guard let proof = d.proof, let kv = d.keyVersion else { return .unproven }
        if kv < v { return .stale }
        if kv != v { return .unproven }
        return Verify.checkDeviceKeyProof(verifyKey: verifyKey, deviceID: d.deviceId, v, publicKey: pub, proof: proof) ? nil : .unproven
    }

    /// A rotation to v+1 (§1.8 Rotation, §1.13 Rotating); refuses unless the signed recovery key verifies with the own ADK(1).
    public static func prepareRotation(
        _ store: any KeyStore, serverKeyVersion: Int, recovery: RecoveryInfo, devices: [DeviceKey], exclude: [String] = []
    ) async throws -> PreparedRotation {
        let local = try await store.current()
        if local != serverKeyVersion {
            throw CryptoError(
                local < serverKeyVersion ? "not_found" : "invalid_input",
                "local ADK version \(local) differs from the server's \(serverKeyVersion)"
            )
        }
        if try await !store.has(1) { throw unverified("this device lacks ADK version 1 to check the recovery key against") }
        let verifyKeyV1 = try await Authenticity.verifyKey(store.adk(1))
        try Verify.assertRecoveryKeySigned(recovery.publicKey, recovery.signature, verifyKeyV1: verifyKeyV1)
        let ex = Set(exclude.map { $0.lowercased() })
        let next = Primitives.random(32)
        let previous = try await store.adk(local)
        let currentVerifyKey = try Authenticity.verifyKey(previous)
        let chain = try Wrap.wrapChain(previous: previous, newer: next, keyVersion: local + 1)
        let recoveryBlob = try Wrap.wrap(
            adk: next, senderPrivate: Primitives.random(32), recipientPublic: B64u.decode(recovery.publicKey), purpose: "recovery",
            keyVersion: local + 1
        )
        var skipped: [(String, Skip)] = []
        var blobs: [DeviceBlob] = []
        for d in devices {
            if let reason = skipReason(d, local, verifyKey: currentVerifyKey, exclude: ex) {
                skipped.append((d.deviceId, reason))
                continue
            }
            let wrapped = try Wrap.wrap(
                adk: next, senderPrivate: Primitives.random(32), recipientPublic: B64u.decode(d.publicKey ?? ""), purpose: "rotate",
                keyVersion: local + 1
            )
            blobs.append(DeviceBlob(deviceId: d.deviceId, blob: B64u.encode(wrapped)))
        }
        let verifyKey = try Authenticity.verifyKey(next)
        let signature = try Authenticity.sign(
            previous,
            Authenticity.rotationMessage(keyVersion: local + 1, verifyKey: verifyKey, chainBlob: chain)
        )
        let request = KeysRotateRequest(
            keyVersion: local + 1, recoveryBlob: B64u.encode(recoveryBlob), chainBlob: B64u.encode(chain), deviceBlobs: blobs,
            verifyKey: B64u.encode(verifyKey), signature: B64u.encode(signature)
        )
        return PreparedRotation(request: request, skipped: skipped, next: next, version: local + 1)
    }
}
