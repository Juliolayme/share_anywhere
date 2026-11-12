import Foundation

/// Account Data Key subkeys (§1.2): HKDF-SHA256(ADK, salt = empty, info = label, 32).
public enum ADK {
    public static let clipboard = "clipboard-v1"
    public static let history = "history-v1"

    public static func subkey(_ adk: [UInt8], label: String) throws -> [UInt8] {
        guard adk.count == Primitives.keyBytes else { throw CryptoError("invalid_key", "ADK size") }
        return Primitives.hkdf(adk, salt: [], info: Array(label.utf8))
    }
}

/// One encrypted clipboard event or history entry (§1.3).
public struct EncryptedItem: Sendable, Equatable {
    public let nonce: [UInt8]
    public let ciphertext: [UInt8]
    public init(nonce: [UInt8], ciphertext: [UInt8]) {
        self.nonce = nonce
        self.ciphertext = ciphertext
    }
}

public enum Items {
    /// Ids are the lowercase canonical UUID text, which is also what goes into the AAD (§1.3).
    public static func isItemID(_ id: String) -> Bool {
        let c = Array(id.utf8)
        guard c.count == 36 else { return false }
        for (i, ch) in c.enumerated() {
            if [8, 13, 18, 23].contains(i) {
                if ch != UInt8(ascii: "-") { return false }
            } else if !((48 ... 57).contains(ch) || (97 ... 102).contains(ch)) {
                return false
            }
        }
        return true
    }

    public static func newItemID() -> String { UUID().uuidString.lowercased() }

    /// History entry ids are version-8 UUIDs from the first 16 bytes of a SHA-256 (as the Web's itemIdFromBytes).
    public static func itemID(fromBytes bytes: [UInt8]) -> String {
        var b = Array(bytes.prefix(16))
        while b.count < 16 {
            b.append(0)
        }
        b[6] = (b[6] & 0x0F) | 0x80
        b[8] = (b[8] & 0x3F) | 0x80
        let h = b.hexString
        let s = Array(h)
        return String(s[0 ..< 8]) + "-" + String(s[8 ..< 12]) + "-" + String(s[12 ..< 16]) + "-" + String(s[16 ..< 20]) + "-" +
            String(s[20 ..< 32])
    }

    public static func aad(id: String, keyVersion: Int) throws -> [UInt8] {
        guard isItemID(id), keyVersion >= 1 else { throw CryptoError("invalid_input", "item id or key version") }
        return Array("\(id)|\(keyVersion)".utf8)
    }

    public static func encrypt(
        subkey: [UInt8], id: String, keyVersion: Int, _ plaintext: [UInt8], nonce: [UInt8] = Primitives.random(Primitives.nonceBytes)
    ) throws -> EncryptedItem {
        try EncryptedItem(
            nonce: nonce,
            ciphertext: Primitives.aesGCMSeal(key: subkey, nonce: nonce, plaintext, aad: aad(id: id, keyVersion: keyVersion))
        )
    }

    public static func decrypt(subkey: [UInt8], id: String, keyVersion: Int, _ item: EncryptedItem) throws -> [UInt8] {
        try Primitives.aesGCMOpen(key: subkey, nonce: item.nonce, item.ciphertext, aad: aad(id: id, keyVersion: keyVersion))
    }
}

/// ECIES wrapping of an ADK to an X25519 public key, and the version chain (§1.4, §1.5).
public enum Wrap {
    public static let info = "sa-wrap-v1"
    public static let wrappedBytes = 32 + 12 + 32 + 16 // 92
    public static let chainBytes = 12 + 32 + 16 // 60
    public static let purposes: Set<String> = ["pair", "rotate", "recovery"]

    public static func aad(purpose: String, keyVersion: Int) throws -> [UInt8] {
        guard purposes.contains(purpose), keyVersion >= 1 else { throw CryptoError("invalid_input", "wrap purpose or version") }
        return Array("\(purpose)|\(keyVersion)".utf8)
    }

    public static func wrapKey(shared: [UInt8], senderPublic: [UInt8], recipientPublic: [UInt8]) -> [UInt8] {
        Primitives.hkdf(shared, salt: senderPublic + recipientPublic, info: Array(info.utf8))
    }

    /// blob = sender_pub (32) ‖ nonce (12) ‖ AES-256-GCM(key, nonce, ADK, aad) (48).
    public static func wrap(
        adk: [UInt8], senderPrivate: [UInt8], recipientPublic: [UInt8], purpose: String, keyVersion: Int,
        nonce: [UInt8] = Primitives.random(Primitives.nonceBytes)
    ) throws -> [UInt8] {
        let senderPublic = try Primitives.x25519PublicKey(senderPrivate)
        let shared = try Primitives.x25519(senderPrivate, recipientPublic)
        let key = wrapKey(shared: shared, senderPublic: senderPublic, recipientPublic: recipientPublic)
        return try senderPublic + nonce + (Primitives.aesGCMSeal(
            key: key,
            nonce: nonce,
            adk,
            aad: aad(purpose: purpose, keyVersion: keyVersion)
        ))
    }

    public static func senderPublicKey(_ blob: [UInt8]) throws -> [UInt8] {
        guard blob.count == wrappedBytes else { throw CryptoError("invalid_blob") }
        return Array(blob[0 ..< 32])
    }

    public static func unwrap(_ blob: [UInt8], recipientPrivate: [UInt8], purpose: String, keyVersion: Int) throws -> [UInt8] {
        guard blob.count == wrappedBytes else { throw CryptoError("invalid_blob") }
        let senderPublic = Array(blob[0 ..< 32])
        let nonce = Array(blob[32 ..< 44])
        let sealed = Array(blob[44...])
        let recipientPublic = try Primitives.x25519PublicKey(recipientPrivate)
        let shared = try Primitives.x25519(recipientPrivate, senderPublic)
        let key = wrapKey(shared: shared, senderPublic: senderPublic, recipientPublic: recipientPublic)
        return try Primitives.aesGCMOpen(key: key, nonce: nonce, sealed, aad: aad(purpose: purpose, keyVersion: keyVersion))
    }

    public static func chainAAD(keyVersion: Int) throws -> [UInt8] {
        guard keyVersion >= 2 else { throw CryptoError("invalid_input", "chain version") }
        return Array("chain|\(keyVersion)".utf8)
    }

    /// chain blob v = nonce ‖ AES-256-GCM(ADK(v), nonce, ADK(v-1), "chain|v").
    public static func wrapChain(
        previous: [UInt8],
        newer: [UInt8],
        keyVersion: Int,
        nonce: [UInt8] = Primitives.random(Primitives.nonceBytes)
    ) throws -> [UInt8] {
        try nonce + (Primitives.aesGCMSeal(key: newer, nonce: nonce, previous, aad: chainAAD(keyVersion: keyVersion)))
    }

    public static func unwrapChain(_ blob: [UInt8], newer: [UInt8], keyVersion: Int) throws -> [UInt8] {
        guard blob.count == chainBytes else { throw CryptoError("invalid_blob") }
        return try Primitives.aesGCMOpen(
            key: newer,
            nonce: Array(blob[0 ..< 12]),
            Array(blob[12...]),
            aad: chainAAD(keyVersion: keyVersion)
        )
    }
}

/// BIP-39 English phrases, wordlist and checksum only (§1.6); Argon2id derives the key, not PBKDF2.
public enum Phrase {
    public static let words = 12
    public static let entropyBytes = 16

    public static let wordlist: [String] = {
        guard let url = Bundle.module.url(forResource: "bip39-english", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { fatalError("bip39-english.txt missing") }
        let list = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        precondition(list.count == 2048, "BIP-39 wordlist must have 2048 words")
        return list
    }()

    private static let index: [String: Int] = Dictionary(uniqueKeysWithValues: wordlist.enumerated().map { ($1, $0) })

    /// NFKD, lower case, trimmed, single ASCII spaces.
    public static func normalize(_ input: String) -> String {
        input.decomposedStringWithCompatibilityMapping.lowercased()
            .split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" || $0 == "\u{0B}" || $0 == "\u{0C}" })
            .joined(separator: " ")
    }

    private static func bits(_ v: Int, _ width: Int) -> [Bool] { (0 ..< width).map { (v >> (width - 1 - $0)) & 1 == 1 } }

    public static func fromEntropy(_ entropy: [UInt8]) -> String {
        precondition((16 ... 32).contains(entropy.count) && entropy.count % 4 == 0, "BIP-39 entropy must be 16-32 bytes in steps of 4")
        let cs = entropy.count / 4
        var b = entropy.flatMap { bits(Int($0), 8) }
        b += bits(Int(Primitives.sha256(entropy)[0]), 8).prefix(cs)
        return stride(from: 0, to: b.count, by: 11).map { i in
            wordlist[b[i ..< i + 11].reduce(0) { $0 << 1 | ($1 ? 1 : 0) }]
        }.joined(separator: " ")
    }

    public static func generate() -> String { fromEntropy(Primitives.random(entropyBytes)) }

    /// Why a typed phrase is not a recovery phrase: word_count, unknown_word (with the word) or checksum; nil when valid.
    public struct Problem: Equatable, Sendable {
        public let reason: String
        public let word: String?
    }

    public static func check(_ input: String) -> Problem? {
        let w = normalize(input).split(separator: " ").map(String.init)
        if w.count != words { return Problem(reason: "word_count", word: nil) }
        if let bad = w.first(where: { index[$0] == nil }) { return Problem(reason: "unknown_word", word: bad) }
        do {
            _ = try toEntropy(w.joined(separator: " "))
            return nil
        } catch let e as CryptoError {
            return Problem(reason: e.detail, word: nil)
        } catch {
            return Problem(reason: "checksum", word: nil)
        }
    }

    public static func toEntropy(_ input: String) throws -> [UInt8] {
        let w = normalize(input).split(separator: " ").map(String.init)
        guard (12 ... 24).contains(w.count), w.count % 3 == 0 else { throw CryptoError("invalid_phrase", "word_count") }
        var b = [Bool]()
        for word in w {
            guard let i = index[word] else { throw CryptoError("invalid_phrase", "unknown_word") }
            b += bits(i, 11)
        }
        let cs = w.count / 3
        let entBits = b.count - cs
        let entropy = stride(from: 0, to: entBits, by: 8).map { i in UInt8(b[i ..< i + 8].reduce(0) { $0 << 1 | ($1 ? 1 : 0) }) }
        let expected = Array(bits(Int(Primitives.sha256(entropy)[0]), 8).prefix(cs))
        guard Array(b[entBits...]) == expected else { throw CryptoError("invalid_phrase", "checksum") }
        return entropy
    }
}

/// The recovery keypair and anchor key from a phrase (§1.6, §1.13).
public enum Recovery {
    public struct Derived: Sendable {
        public let seed: [UInt8]
        public let privateKey: [UInt8]
        public let publicKey: [UInt8]
    }

    public static func derive(phrase: String, salt: [UInt8], params: Primitives.ArgonParams) throws -> Derived {
        try Primitives.checkArgon(params, salt: salt)
        let seed = try Primitives.argon2id(password: Array(Phrase.normalize(phrase).utf8), salt: salt, params: params)
        let priv = Primitives.clamp(seed)
        return try Derived(seed: seed, privateKey: priv, publicKey: Primitives.x25519PublicKey(priv))
    }
}

/// Version signing keys, proofs and the recovery anchor (§1.13).
public enum Authenticity {
    public static let signInfo = "sa-keyver-sign-v1"
    public static let anchorInfo = "sa-recovery-anchor-v1"

    public static func signSeed(_ adk: [UInt8]) -> [UInt8] { Primitives.hkdf(adk, salt: [], info: Array(signInfo.utf8)) }

    public static func verifyKey(_ adk: [UInt8]) throws -> [UInt8] { try Primitives.ed25519PublicKey(seed: signSeed(adk)) }

    public static func sign(_ adk: [UInt8], _ message: String) throws -> [UInt8] {
        try Primitives.ed25519Sign(seed: signSeed(adk), Array(message.utf8))
    }

    public static func verify(signature: [UInt8], _ message: String, verifyKey: [UInt8]) -> Bool {
        Primitives.ed25519Verify(signature: signature, Array(message.utf8), publicKey: verifyKey)
    }

    public static func rotationMessage(keyVersion: Int, verifyKey: [UInt8], chainBlob: [UInt8]) -> String {
        "sa-rotate-v1|\(keyVersion)|\(B64u.encode(verifyKey))|\(B64u.encode(Primitives.sha256(chainBlob)))"
    }

    public static func deviceKeyMessage(deviceID: String, keyVersion: Int, publicKey: [UInt8]) throws -> String {
        guard Items.isItemID(deviceID) else { throw CryptoError("invalid_input", "device id") }
        return "sa-devkey-v1|\(deviceID)|\(keyVersion)|\(B64u.encode(publicKey))"
    }

    public static func recoveryKeyMessage(_ recoveryPublicKey: [UInt8]) -> String { "sa-recoverykey-v1|\(B64u.encode(recoveryPublicKey))" }

    public static func anchorMessage(_ verifyKeyV1: [UInt8]) -> String { "sa-anchor-v1|\(B64u.encode(verifyKeyV1))" }

    public static func anchorKey(_ recoverySeed: [UInt8]) -> [UInt8] { Primitives
        .hkdf(recoverySeed, salt: [], info: Array(anchorInfo.utf8))
    }

    public static func recoveryAnchor(anchorKey: [UInt8], verifyKeyV1: [UInt8]) -> [UInt8] {
        Primitives.hmacSHA256(key: anchorKey, Array(anchorMessage(verifyKeyV1).utf8))
    }
}
