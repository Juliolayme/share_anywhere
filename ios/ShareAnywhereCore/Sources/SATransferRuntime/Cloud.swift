import Crypto
import Foundation

// Cloud Distribution (docs/TRANSFER_PROTOCOL.md §9, docs/API.md §2.6): the per-file crypto shared byte for byte with
// the Web and Android through `shared/protocol/schemas/cloud-vectors.json`, the API calls, the sender's uploader and
// key responder, and the receiver's key request and download.

/// Cloud calls (docs/API.md §2.6). Parts travel as raw bytes.
public protocol CloudService: Sendable {
    func cloudSettings() async throws -> CloudSettings
    func putCloudSettings(enabled: Bool, consent: Bool, budgetBytes: Int64?) async throws -> CloudSettings
    func estimateCloud(bytes: Int64, receivers: Int) async throws -> CloudEstimate
    func distribute(fileId: String) async throws -> CloudObject
    func putPart(objectId: String, n: Int, bytes: [UInt8]) async throws -> CloudObject
    func seal(objectId: String) async throws -> CloudObject
    func cloudObjects(sessionId: String) async throws -> [CloudObject]
    func getPart(objectId: String, n: Int) async throws -> [UInt8]
    func received(objectId: String) async throws -> CloudObject
}

private struct CloudSettingsBody: Encodable, Sendable {
    let enabled: Bool
    let consent: Bool
    let budgetBytes: Int64?
    enum CodingKeys: String, CodingKey { case enabled, consent, budgetBytes = "budget_bytes" }
}

private struct EstimateBody: Encodable, Sendable {
    let bytes: Int64
    let receivers: Int
}

private struct ObjectList: Decodable, Sendable { let objects: [CloudObject] }

extension LiveServices: CloudService {
    public func cloudSettings() async throws -> CloudSettings { try await cloudCall(APIOperations.getCloudSettings) }

    public func putCloudSettings(enabled: Bool, consent: Bool, budgetBytes: Int64?) async throws -> CloudSettings {
        try await cloudCall(
            APIOperations.putCloudSettings,
            body: CloudSettingsBody(enabled: enabled, consent: consent, budgetBytes: budgetBytes)
        )
    }

    public func estimateCloud(bytes: Int64, receivers: Int) async throws -> CloudEstimate {
        try await cloudCall(APIOperations.estimateCloud, body: EstimateBody(bytes: bytes, receivers: receivers))
    }

    public func distribute(fileId: String) async throws -> CloudObject {
        try await cloudCall(APIOperations.distributeFile, path: path(APIOperations.distributeFile, "id", fileId))
    }

    public func putPart(objectId: String, n: Int, bytes: [UInt8]) async throws -> CloudObject {
        let p = path(APIOperations.putCloudPart, "id", objectId).replacingOccurrences(of: "{n}", with: String(n))
        let data = try await raw(APIOperations.putCloudPart, path: p, body: Data(bytes))
        return try APIClient.decoder.decode(CloudObject.self, from: data)
    }

    public func seal(objectId: String) async throws -> CloudObject {
        try await cloudCall(APIOperations.sealCloudObject, path: path(APIOperations.sealCloudObject, "id", objectId))
    }

    public func cloudObjects(sessionId: String) async throws -> [CloudObject] {
        let l: ObjectList = try await cloudCall(
            APIOperations.listSessionCloudObjects,
            path: path(APIOperations.listSessionCloudObjects, "id", sessionId)
        )
        return l.objects
    }

    public func getPart(objectId: String, n: Int) async throws -> [UInt8] {
        let p = path(APIOperations.getCloudPart, "id", objectId).replacingOccurrences(of: "{n}", with: String(n))
        return try await [UInt8](raw(APIOperations.getCloudPart, path: p, body: nil))
    }

    public func received(objectId: String) async throws -> CloudObject {
        try await cloudCall(APIOperations.receivedCloudObject, path: path(APIOperations.receivedCloudObject, "id", objectId))
    }
}

// MARK: - Crypto

public enum CloudCrypto {
    public static let partOverhead = 28
    public static let fileKeyBytes = 32

    static func partAAD(_ objectId: String, _ n: Int, _ count: Int) -> Data { Data("sa-cloud-v1|\(objectId)|\(n)|\(count)".utf8) }

    public static func newFileKey() -> [UInt8] { (0 ..< fileKeyBytes).map { _ in UInt8.random(in: 0 ... 255) } }

    /// Stored part: nonce || ciphertext || tag.
    public static func sealPart(
        key: [UInt8], objectId: String, n: Int, count: Int, plaintext: [UInt8], nonce: [UInt8]? = nil
    ) throws -> [UInt8] {
        let box = try AES.GCM.seal(
            plaintext,
            using: SymmetricKey(data: key),
            nonce: nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce(),
            authenticating: partAAD(objectId, n, count)
        )
        return [UInt8](box.nonce) + [UInt8](box.ciphertext) + [UInt8](box.tag)
    }

    /// Opens a stored part; throws when it was altered, moved or truncated.
    public static func openPart(key: [UInt8], objectId: String, n: Int, count: Int, stored: [UInt8]) throws -> [UInt8] {
        guard stored.count >= partOverhead else { throw CloudError.integrity }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: stored[0 ..< 12]),
            ciphertext: stored[12 ..< stored.count - 16],
            tag: stored[(stored.count - 16)...]
        )
        do {
            return try [UInt8](AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: partAAD(objectId, n, count)))
        } catch {
            throw CloudError.integrity
        }
    }

    static func wrapKey(
        mine: Curve25519.KeyAgreement.PrivateKey, peer: [UInt8], senderPublic: [UInt8], receiverPublic: [UInt8], sessionId: String,
        receiverPid: String
    ) throws -> SymmetricKey {
        let shared = try mine.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer))
        return shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: senderPublic + receiverPublic,
            sharedInfo: Data("sa-cloud-key-v1|\(sessionId)|\(receiverPid)".utf8),
            outputByteCount: 32
        )
    }

    static func wrapAAD(_ objectId: String, _ fileId: String) -> Data { Data("sa-cloud-wrap-v1|\(objectId)|\(fileId)".utf8) }

    /// The sender's CLOUD_KEY answer to a receiver's CLOUD_KEY_REQUEST.
    public static func wrapKeys(
        _ keys: [CloudObjectKey], receiverPublic: String, sessionId: String, receiverPid: String,
        sender: Curve25519.KeyAgreement.PrivateKey = .init(), nonces: [[UInt8]]? = nil
    ) throws -> CloudKeyPayload {
        guard let rpub = b64uDecode(receiverPublic), rpub.count == 32 else { throw CloudError.integrity }
        let spub = [UInt8](sender.publicKey.rawRepresentation)
        let k = try wrapKey(
            mine: sender,
            peer: rpub,
            senderPublic: spub,
            receiverPublic: rpub,
            sessionId: sessionId,
            receiverPid: receiverPid
        )
        var out: [CloudWrappedKey] = []
        for (i, o) in keys.enumerated() {
            let nonce = try nonces.map { try AES.GCM.Nonce(data: $0[i]) } ?? AES.GCM.Nonce()
            let box = try AES.GCM.seal(o.key + o.sha256, using: k, nonce: nonce, authenticating: wrapAAD(o.objectId, o.fileId))
            out.append(CloudWrappedKey(
                objectId: o.objectId, fileId: o.fileId, nonce: b64uEncode([UInt8](box.nonce)),
                wrapped: b64uEncode([UInt8](box.ciphertext) + [UInt8](box.tag))
            ))
        }
        return CloudKeyPayload(publicKey: b64uEncode(spub), keys: out)
    }

    /// The receiver unwraps a CLOUD_KEY answer with its ephemeral key; entries that fail authentication are skipped.
    public static func unwrapKeys(
        _ payload: CloudKeyPayload, receiver: Curve25519.KeyAgreement.PrivateKey, sessionId: String, receiverPid: String
    ) -> [CloudObjectKey] {
        guard let spub = b64uDecode(payload.publicKey), spub.count == 32 else { return [] }
        let rpub = [UInt8](receiver.publicKey.rawRepresentation)
        guard let k = try? wrapKey(
            mine: receiver,
            peer: spub,
            senderPublic: spub,
            receiverPublic: rpub,
            sessionId: sessionId,
            receiverPid: receiverPid
        )
        else { return [] }
        return payload.keys.compactMap { w in
            guard let nonce = b64uDecode(w.nonce), let blob = b64uDecode(w.wrapped), blob.count >= 16,
                  let box = try? AES.GCM.SealedBox(
                      nonce: AES.GCM.Nonce(data: nonce),
                      ciphertext: blob[0 ..< blob.count - 16],
                      tag: blob[(blob.count - 16)...]
                  ),
                  let plain = try? [UInt8](AES.GCM.open(box, using: k, authenticating: wrapAAD(w.objectId, w.fileId))),
                  plain.count == 64 else { return nil }
            return CloudObjectKey(objectId: w.objectId, fileId: w.fileId, key: Array(plain[0 ..< 32]), sha256: Array(plain[32...]))
        }
    }
}

public enum CloudError: Error, Sendable, Equatable {
    case integrity, paused, unavailable, network
}

public struct CloudObjectKey: Sendable, Equatable {
    public var objectId: String
    public var fileId: String
    public var key: [UInt8]
    /// SHA-256 of the whole plaintext file.
    public var sha256: [UInt8]

    public init(objectId: String, fileId: String, key: [UInt8], sha256: [UInt8]) {
        self.objectId = objectId
        self.fileId = fileId
        self.key = key
        self.sha256 = sha256
    }
}

public struct CloudWrappedKey: Codable, Sendable, Equatable {
    public var objectId: String
    public var fileId: String
    public var nonce: String
    public var wrapped: String
    enum CodingKeys: String, CodingKey { case objectId = "object_id", fileId = "file_id", nonce, wrapped }
}

public struct CloudKeyPayload: Codable, Sendable, Equatable {
    public var publicKey: String
    public var keys: [CloudWrappedKey]
    enum CodingKeys: String, CodingKey { case publicKey = "public_key", keys }
}

struct CloudKeyRequestPayload: Codable, Sendable {
    let publicKey: String
    enum CodingKeys: String, CodingKey { case publicKey = "public_key" }
}

func b64uEncode(_ b: [UInt8]) -> String {
    Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func b64uDecode(_ s: String) -> [UInt8]? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 {
        t += "="
    }
    return Data(base64Encoded: t).map { [UInt8]($0) }
}
