import CArgon2
import Crypto
import Foundation

/// A cryptographic failure, reported with one code and no detail (docs/CLIPBOARD_PROTOCOL.md §1.3).
public struct CryptoError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let detail: String
    public init(_ code: String, _ detail: String? = nil) {
        self.code = code
        self.detail = detail ?? code
    }

    public var description: String { detail }
}

/// The primitives of the account-key protocol (docs/CLIPBOARD_PROTOCOL.md §1, docs/ADR/0024-ios-crypto.md): SHA-256,
/// HMAC, HKDF-SHA256, AES-256-GCM, X25519 and Ed25519 (CryptoKit through swift-crypto) and Argon2id (vendored
/// reference implementation). Byte for byte the Web's `web/src/lib/crypto` and Android's `account/crypto`, checked by
/// clipboard-vectors.json.
public enum Primitives {
    public static let keyBytes = 32
    public static let nonceBytes = 12
    public static let tagBytes = 16

    public static func random(_ n: Int) -> [UInt8] {
        var g = SystemRandomNumberGenerator()
        return (0 ..< n).map { _ in UInt8.random(in: 0 ... 255, using: &g) }
    }

    public static func sha256(_ data: [UInt8]) -> [UInt8] { Array(SHA256.hash(data: data)) }

    public static func hmacSHA256(key: [UInt8], _ data: [UInt8]) -> [UInt8] {
        Array(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    /// HKDF-SHA256. An empty salt means HashLen zero bytes (RFC 5869), as WebCrypto's HKDF does.
    public static func hkdf(_ ikm: [UInt8], salt: [UInt8], info: [UInt8], length: Int = keyBytes) -> [UInt8] {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: length
        )
        return key.withUnsafeBytes { Array($0) }
    }

    public static func aesGCMSeal(key: [UInt8], nonce: [UInt8], _ plaintext: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        guard key.count == keyBytes, nonce.count == nonceBytes else { throw CryptoError("invalid_input", "AES-256-GCM key or nonce size") }
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return Array(box.ciphertext) + Array(box.tag)
    }

    /// Opens AES-256-GCM; any failure is the single `decrypt_failed` error.
    public static func aesGCMOpen(key: [UInt8], nonce: [UInt8], _ sealed: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        guard key.count == keyBytes, nonce.count == nonceBytes, sealed.count >= tagBytes else { throw CryptoError("decrypt_failed") }
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonce), ciphertext: sealed.dropLast(tagBytes), tag: sealed.suffix(tagBytes)
            )
            return try Array(AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad))
        } catch {
            throw CryptoError("decrypt_failed")
        }
    }

    /// RFC 7748 clamping of an X25519 scalar (copy).
    public static func clamp(_ scalar: [UInt8]) -> [UInt8] {
        precondition(scalar.count == keyBytes, "X25519 scalar size")
        var s = scalar
        s[0] &= 248
        s[31] = (s[31] & 127) | 64
        return s
    }

    public static func x25519PublicKey(_ privateKey: [UInt8]) throws -> [UInt8] {
        do {
            return try Array(Curve25519.KeyAgreement.PrivateKey(rawRepresentation: clamp(privateKey)).publicKey.rawRepresentation)
        } catch {
            throw CryptoError("invalid_key")
        }
    }

    /// X25519(priv, pub), rejecting an all-zero result (low-order public key, §1.11).
    public static func x25519(_ privateKey: [UInt8], _ publicKey: [UInt8]) throws -> [UInt8] {
        guard publicKey.count == keyBytes else { throw CryptoError("invalid_key") }
        let out: [UInt8]
        do {
            let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: clamp(privateKey))
            let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
            out = try priv.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Array($0) }
        } catch {
            throw CryptoError("invalid_key", "low-order X25519 public key")
        }
        if out.allSatisfy({ $0 == 0 }) { throw CryptoError("invalid_key", "low-order X25519 public key") }
        return out
    }

    public static func ed25519PublicKey(seed: [UInt8]) throws -> [UInt8] {
        do {
            return try Array(Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation)
        } catch {
            throw CryptoError("invalid_key")
        }
    }

    /// Ed25519 signature. CryptoKit's signatures are randomized on Apple platforms (RFC 8032 permits verification
    /// of either form); peers verify, never compare signature bytes.
    public static func ed25519Sign(seed: [UInt8], _ message: [UInt8]) throws -> [UInt8] {
        do {
            return try Array(Curve25519.Signing.PrivateKey(rawRepresentation: seed).signature(for: message))
        } catch {
            throw CryptoError("invalid_key")
        }
    }

    public static func ed25519Verify(signature: [UInt8], _ message: [UInt8], publicKey: [UInt8]) -> Bool {
        guard signature.count == 64, publicKey.count == 32,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }

    public struct ArgonParams: Sendable, Equatable {
        public let m: Int
        public let t: Int
        public let p: Int
        public init(m: Int, t: Int, p: Int) {
            self.m = m
            self.t = t
            self.p = p
        }
    }

    /// Accepted server-supplied Argon2id parameters (§1.6): weaker would ease guessing, larger could exhaust the device.
    public static func checkArgon(_ params: ArgonParams, salt: [UInt8]) throws {
        guard (65536 ... 262_144).contains(params.m), (3 ... 10).contains(params.t), (1 ... 4).contains(params.p), salt.count == 16 else {
            throw CryptoError("invalid_params", "Argon2id parameters out of range")
        }
    }

    /// Argon2id v1.3 (RFC 9106), computed on one thread (lanes are processed in turn, so p > 1 gives the same result).
    public static func argon2id(password: [UInt8], salt: [UInt8], params: ArgonParams, length: Int = keyBytes) throws -> [UInt8] {
        var out = [UInt8](repeating: 0, count: length)
        let rc = password.withUnsafeBytes { pw in
            salt.withUnsafeBytes { s in
                out.withUnsafeMutableBytes { o in
                    argon2id_hash_raw(
                        UInt32(params.t), UInt32(params.m), UInt32(params.p), pw.baseAddress, pw.count, s.baseAddress, s.count,
                        o.baseAddress, o.count
                    )
                }
            }
        }
        guard rc == 0 else { throw CryptoError("invalid_params", "argon2id failed: \(rc)") }
        return out
    }

    public static func constantTimeEquals(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var d: UInt8 = 0
        for i in a.indices {
            d |= a[i] ^ b[i]
        }
        return d == 0
    }
}

/// Base64url without padding, strict (§1.10): no padding, no other alphabet, no non-canonical trailing bits.
public enum B64u {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
    private static let index: [Int] = {
        var t = [Int](repeating: -1, count: 128)
        for (i, c) in alphabet.enumerated() {
            t[Int(c)] = i
        }
        return t
    }()

    public static func encode(_ bytes: [UInt8]) -> String {
        var out = [UInt8]()
        var i = 0
        while i + 3 <= bytes.count {
            let n = Int(bytes[i]) << 16 | Int(bytes[i + 1]) << 8 | Int(bytes[i + 2])
            out += [alphabet[n >> 18], alphabet[(n >> 12) & 63], alphabet[(n >> 6) & 63], alphabet[n & 63]]
            i += 3
        }
        let rest = bytes.count - i
        if rest == 1 {
            let n = Int(bytes[i]) << 16
            out += [alphabet[n >> 18], alphabet[(n >> 12) & 63]]
        } else if rest == 2 {
            let n = Int(bytes[i]) << 16 | Int(bytes[i + 1]) << 8
            out += [alphabet[n >> 18], alphabet[(n >> 12) & 63], alphabet[(n >> 6) & 63]]
        }
        return String(decoding: out, as: UTF8.self)
    }

    public static func decode(_ text: String) throws -> [UInt8] {
        let chars = Array(text.utf8)
        if chars.count % 4 == 1 { throw CryptoError("invalid_encoding", "base64url: impossible length") }
        var out = [UInt8]()
        out.reserveCapacity(chars.count * 3 / 4)
        var acc = 0, bits = 0
        for c in chars {
            let v = c < 128 ? index[Int(c)] : -1
            if v < 0 { throw CryptoError("invalid_encoding", "base64url: invalid character") }
            acc = (acc << 6) | v
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((acc >> bits) & 0xFF))
            }
            acc &= (1 << bits) - 1 // keep only the bits not yet emitted
        }
        if bits > 0, acc & ((1 << bits) - 1) != 0 { throw CryptoError("invalid_encoding", "base64url: non-canonical encoding") }
        return out
    }
}

public extension [UInt8] {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }

    init?(hex: String) {
        let c = Array(hex.utf8)
        guard c.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(c.count / 2)
        var i = 0
        while i < c.count {
            guard let b = UInt8(String(decoding: c[i ..< i + 2], as: UTF8.self), radix: 16) else { return nil }
            out.append(b)
            i += 2
        }
        self = out
    }
}
