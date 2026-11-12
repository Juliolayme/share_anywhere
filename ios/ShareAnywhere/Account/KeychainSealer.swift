import CryptoKit
import Foundation
import SAAccount
import Security

/// Seals the account key vault (every ADK version and the device wrapping key, docs/CLIPBOARD_PROTOCOL.md §1.9) with a
/// key that never leaves this device: on hardware with a Secure Enclave, an AES key derived from an Enclave P-256 key
/// (ECDH with a stored public key, then HKDF), so the vault cannot be opened without that chip; elsewhere (the
/// simulator) a random AES-256 key in the Keychain. Every Keychain item is `AfterFirstUnlockThisDeviceOnly` and not
/// synchronizable, so it is never in iCloud Keychain or a backup restored to another device (docs/ADR/0024).
final class KeychainSealer: Sealer, @unchecked Sendable {
    private let service = "app.shareanywhere.account-keys"
    private let lock = NSLock()
    private var cached: [UInt8]?

    func seal(_ plaintext: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        let key = try key()
        let nonce = Primitives.random(Primitives.nonceBytes)
        return try nonce + Primitives.aesGCMSeal(key: key, nonce: nonce, plaintext, aad: aad)
    }

    func open(_ blob: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        guard blob.count > Primitives.nonceBytes else { throw CryptoError("decrypt_failed") }
        return try Primitives.aesGCMOpen(
            key: key(), nonce: Array(blob.prefix(Primitives.nonceBytes)), Array(blob.dropFirst(Primitives.nonceBytes)), aad: aad
        )
    }

    func destroy() {
        lock.locked { cached = nil }
        for account in ["vault-key", "enclave-key", "enclave-peer"] {
            delete(account)
        }
    }

    private func key() throws -> [UInt8] {
        try lock.locked {
            if let cached { return cached }
            let k = try SecureEnclave.isAvailable ? enclaveKey() : plainKey()
            cached = k
            return k
        }
    }

    private func plainKey() throws -> [UInt8] {
        if let data = read("vault-key"), data.count == 32 { return [UInt8](data) }
        let k = Primitives.random(32)
        try write("vault-key", Data(k))
        return k
    }

    private func enclaveKey() throws -> [UInt8] {
        let enclave: SecureEnclave.P256.KeyAgreement.PrivateKey
        if let data = read("enclave-key"), let k = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: data) {
            enclave = k
        } else {
            enclave = try SecureEnclave.P256.KeyAgreement.PrivateKey()
            try write("enclave-key", enclave.dataRepresentation)
            delete("enclave-peer")
        }
        let peer: P256.KeyAgreement.PublicKey
        if let data = read("enclave-peer"), let k = try? P256.KeyAgreement.PublicKey(rawRepresentation: data) {
            peer = k
        } else {
            peer = P256.KeyAgreement.PrivateKey().publicKey
            try write("enclave-peer", peer.rawRepresentation)
        }
        let shared = try enclave.sharedSecretFromKeyAgreement(with: peer)
        let symmetric = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(),
            sharedInfo: Data("sa-vault-v1".utf8),
            outputByteCount: 32
        )
        return symmetric.withUnsafeBytes { [UInt8]($0) }
    }

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any
        ]
    }

    private func read(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    private func write(_ account: String, _ data: Data) throws {
        delete(account)
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    private func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }
}
