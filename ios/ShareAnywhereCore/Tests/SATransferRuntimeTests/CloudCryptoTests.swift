import Crypto
import Foundation
@testable import SATransferRuntime
import XCTest

/// The iOS cloud crypto reproduces shared/protocol/schemas/cloud-vectors.json (docs/TRANSFER_PROTOCOL.md §9), as the
/// Web and Android do.
final class CloudCryptoTests: XCTestCase {
    private func vectors(_ file: String = #filePath) throws -> [String: Any] {
        var root = URL(fileURLWithPath: file)
        for _ in 0 ..< 5 {
            root.deleteLastPathComponent()
        }
        let data = try Data(contentsOf: root.appendingPathComponent("shared/protocol/schemas/cloud-vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func hex(_ s: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i ..< j], radix: 16) ?? 0)
            i = j
        }
        return out
    }

    private func hexString(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

    func testPartsMatchTheSharedVectors() throws {
        let p = try XCTUnwrap(vectors()["part"] as? [String: Any])
        let key = try hex(XCTUnwrap(p["key"] as? String))
        let oid = try XCTUnwrap(p["object_id"] as? String)
        let count = try XCTUnwrap(p["part_count"] as? Int)
        for part in try XCTUnwrap(p["parts"] as? [[String: Any]]) {
            let n = try XCTUnwrap(part["n"] as? Int)
            let plain = try hex(XCTUnwrap(part["plaintext"] as? String))
            let stored = try CloudCrypto.sealPart(
                key: key, objectId: oid, n: n, count: count, plaintext: plain, nonce: hex(XCTUnwrap(part["nonce"] as? String))
            )
            XCTAssertEqual(hexString(stored), part["stored"] as? String, "part \(n)")
            XCTAssertEqual(try CloudCrypto.openPart(key: key, objectId: oid, n: n, count: count, stored: stored), plain)
            XCTAssertThrowsError(try CloudCrypto.openPart(key: key, objectId: oid, n: n + 1, count: count, stored: stored))
            XCTAssertThrowsError(try CloudCrypto.openPart(key: key, objectId: oid, n: n, count: count + 1, stored: stored))
            var bad = stored
            bad[bad.count - 1] ^= 1
            XCTAssertThrowsError(try CloudCrypto.openPart(key: key, objectId: oid, n: n, count: count, stored: bad))
        }
    }

    func testKeyWrapMatchesTheSharedVectors() throws {
        let v = try vectors()
        let p = try XCTUnwrap(v["part"] as? [String: Any])
        let w = try XCTUnwrap(v["wrap"] as? [String: String])
        let receiver = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(XCTUnwrap(w["receiver_private"])))
        let sender = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(XCTUnwrap(w["sender_private"])))
        XCTAssertEqual(b64uEncode([UInt8](receiver.publicKey.rawRepresentation)), w["receiver_public_b64u"])
        XCTAssertEqual(b64uEncode([UInt8](sender.publicKey.rawRepresentation)), w["sender_public_b64u"])
        let key = try CloudObjectKey(
            objectId: XCTUnwrap(w["object_id"]), fileId: XCTUnwrap(w["file_id"]), key: hex(XCTUnwrap(p["key"] as? String)),
            sha256: hex(XCTUnwrap(p["file_sha256"] as? String))
        )
        let payload = try CloudCrypto.wrapKeys(
            [key], receiverPublic: XCTUnwrap(w["receiver_public_b64u"]), sessionId: XCTUnwrap(w["session_id"]),
            receiverPid: XCTUnwrap(w["receiver_participant_id"]), sender: sender,
            nonces: [XCTUnwrap(b64uDecode(XCTUnwrap(w["nonce_b64u"])))]
        )
        XCTAssertEqual(payload.publicKey, w["sender_public_b64u"])
        XCTAssertEqual(payload.keys.first?.wrapped, w["wrapped_b64u"])
        let back = try CloudCrypto.unwrapKeys(
            payload, receiver: receiver, sessionId: XCTUnwrap(w["session_id"]), receiverPid: XCTUnwrap(w["receiver_participant_id"])
        )
        XCTAssertEqual(back, [key])
        XCTAssertEqual(CloudCrypto.unwrapKeys(payload, receiver: .init(), sessionId: w["session_id"] ?? "", receiverPid: "x"), [])
    }
}
