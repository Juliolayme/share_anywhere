import Foundation
@testable import SAClipboardCrypto
import XCTest

private func repoRoot(_ file: String = #filePath) -> URL {
    URL(fileURLWithPath: file).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
}

private func hx(_ s: String) -> [UInt8] { [UInt8](hex: s)! }

private extension [String: Any] {
    func s(_ k: String) -> String { self[k] as! String }
    func o(_ k: String) -> [String: Any] { self[k] as! [String: Any] }
    func i(_ k: String) -> Int { self[k] as! Int }
}

/// The iOS key library reproduces shared/protocol/schemas/clipboard-vectors.json (docs/CLIPBOARD_PROTOCOL.md §1.12),
/// as the Web and Android libraries do.
final class CryptoVectorsTests: XCTestCase {
    var v: [String: Any] = [:]

    override func setUpWithError() throws {
        let data = try Data(contentsOf: repoRoot().appendingPathComponent("shared/protocol/schemas/clipboard-vectors.json"))
        v = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testADKSubkeysAndItems() throws {
        let a = v.o("adk")
        let adk = hx(a.s("adk"))
        XCTAssertEqual(try ADK.subkey(adk, label: ADK.clipboard).hexString, a.o("subkeys").s("clipboard"))
        XCTAssertEqual(try ADK.subkey(adk, label: ADK.history).hexString, a.o("subkeys").s("history"))
        for it in v.o("items")["vectors"] as! [[String: Any]] {
            let sub = try ADK.subkey(adk, label: it.s("subkey") == "history" ? ADK.history : ADK.clipboard)
            let kv = it.i("key_version")
            XCTAssertEqual(try Items.aad(id: it.s("id"), keyVersion: kv).hexString, it.s("aad_utf8"))
            let enc = try Items.encrypt(subkey: sub, id: it.s("id"), keyVersion: kv, hx(it.s("plaintext_utf8")), nonce: hx(it.s("nonce")))
            XCTAssertEqual(enc.ciphertext.hexString, it.s("ciphertext"))
            XCTAssertEqual(B64u.encode(enc.ciphertext), it.s("ciphertext_b64u"))
            XCTAssertEqual(try Items.decrypt(subkey: sub, id: it.s("id"), keyVersion: kv, enc).hexString, it.s("plaintext_utf8"))
            // The AAD binds the row and the version.
            XCTAssertThrowsError(try Items.decrypt(subkey: sub, id: it.s("id"), keyVersion: kv + 1, enc)) {
                XCTAssertEqual(($0 as? CryptoError)?.code, "decrypt_failed")
            }
        }
    }

    func testWrapAndChain() throws {
        let w = v.o("wrap")
        XCTAssertEqual(Primitives.clamp(hx(w.s("recipient_private"))).hexString, w.s("recipient_private_clamped"))
        XCTAssertEqual(try Primitives.x25519PublicKey(hx(w.s("recipient_private"))).hexString, w.s("recipient_public"))
        XCTAssertEqual(try Primitives.x25519PublicKey(hx(w.s("sender_private"))).hexString, w.s("sender_public"))
        let shared = try Primitives.x25519(hx(w.s("sender_private")), hx(w.s("recipient_public")))
        XCTAssertEqual(shared.hexString, w.s("shared_secret"))
        XCTAssertEqual(
            Wrap.wrapKey(shared: shared, senderPublic: hx(w.s("sender_public")), recipientPublic: hx(w.s("recipient_public"))).hexString,
            w.s("wrap_key")
        )
        for it in w["vectors"] as! [[String: Any]] {
            let kv = it.i("key_version")
            let blob = try Wrap.wrap(
                adk: hx(w.s("adk")), senderPrivate: hx(w.s("sender_private")), recipientPublic: hx(w.s("recipient_public")),
                purpose: it.s("purpose"), keyVersion: kv, nonce: hx(w.s("nonce"))
            )
            XCTAssertEqual(blob.hexString, it.s("blob"))
            XCTAssertEqual(B64u.encode(blob), it.s("blob_b64u"))
            XCTAssertEqual(
                try Wrap.unwrap(blob, recipientPrivate: hx(w.s("recipient_private")), purpose: it.s("purpose"), keyVersion: kv).hexString,
                w.s("adk")
            )
            XCTAssertEqual(try Wrap.senderPublicKey(blob), hx(w.s("sender_public")))
        }
        let c = v.o("chain")
        let chain = try Wrap.wrapChain(previous: hx(c.s("adk_v1")), newer: hx(c.s("adk_v2")), keyVersion: 2, nonce: hx(c.s("nonce")))
        XCTAssertEqual(chain.hexString, c.s("blob"))
        XCTAssertEqual(try Wrap.unwrapChain(chain, newer: hx(c.s("adk_v2")), keyVersion: 2).hexString, c.s("adk_v1"))
        // A rotation blob is not a pairing blob (purpose in the AAD), and a low-order key is refused.
        let rotate = try Wrap.wrap(
            adk: hx(w.s("adk")),
            senderPrivate: hx(w.s("sender_private")),
            recipientPublic: hx(w.s("recipient_public")),
            purpose: "rotate",
            keyVersion: 2
        )
        XCTAssertThrowsError(try Wrap.unwrap(rotate, recipientPrivate: hx(w.s("recipient_private")), purpose: "pair", keyVersion: 2))
        XCTAssertThrowsError(try Primitives.x25519(hx(w.s("sender_private")), [UInt8](repeating: 0, count: 32))) {
            XCTAssertEqual(($0 as? CryptoError)?.code, "invalid_key")
        }
    }

    func testRecoveryPhraseAndArgon2id() throws {
        let r = v.o("recovery")
        XCTAssertEqual(Phrase.fromEntropy(hx(r.s("entropy"))), r.s("phrase"))
        XCTAssertEqual(Phrase.normalize(r.s("typed_input")), r.s("normalized"))
        XCTAssertNil(Phrase.check(r.s("typed_input")))
        XCTAssertEqual(try Phrase.toEntropy(r.s("phrase")).hexString, r.s("entropy"))
        let a = r.o("argon2id")
        let d = try Recovery.derive(phrase: r.s("typed_input"), salt: hx(a.s("salt")), params: .init(m: a.i("m"), t: a.i("t"), p: a.i("p")))
        XCTAssertEqual(d.seed.hexString, r.s("seed"))
        XCTAssertEqual(d.privateKey.hexString, r.s("private_clamped"))
        XCTAssertEqual(d.publicKey.hexString, r.s("public_key"))
        XCTAssertEqual(B64u.encode(d.publicKey), r.s("public_key_b64u"))
        XCTAssertThrowsError(try Recovery.derive(phrase: r.s("phrase"), salt: hx(a.s("salt")), params: .init(m: 1024, t: 1, p: 1)))
    }

    func testArgon2idMatchesRFC9106() throws {
        // RFC 9106 §5.3 inputs without secret and associated data are not published, so check the reference
        // implementation's own known answer for argon2id v1.3 (t=2, m=65536, p=1, "password"/"somesalt").
        let out = try Primitives.argon2id(
            password: Array("password".utf8),
            salt: Array("somesalt".utf8),
            params: .init(m: 65536, t: 2, p: 1)
        )
        XCTAssertEqual(out.hexString, "09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7")
    }

    func testPhraseProblemsAreNamed() {
        let words = Phrase.fromEntropy([UInt8](repeating: 0x7F, count: 16)).split(separator: " ").map(String.init)
        XCTAssertEqual(Phrase.check(words.prefix(11).joined(separator: " "))?.reason, "word_count")
        XCTAssertEqual(
            Phrase.check((words.prefix(11) + ["zzzz"]).joined(separator: " ")),
            Phrase.Problem(reason: "unknown_word", word: "zzzz")
        )
        let swapped = (words.prefix(11) + [words[11] == "abandon" ? "ability" : "abandon"]).joined(separator: " ")
        XCTAssertEqual(Phrase.check(swapped)?.reason, "checksum")
        XCTAssertEqual(Phrase.generate().split(separator: " ").count, 12)
    }

    func testKeyAuthenticity() throws {
        let k = v.o("key_authenticity"), c = v.o("chain")
        let adk1 = hx(c.s("adk_v1")), adk2 = hx(c.s("adk_v2"))
        XCTAssertEqual(Authenticity.signSeed(adk1).hexString, k.s("sign_seed_v1"))
        XCTAssertEqual(try Authenticity.verifyKey(adk1).hexString, k.s("verify_key_v1"))
        XCTAssertEqual(Authenticity.signSeed(adk2).hexString, k.s("sign_seed_v2"))
        XCTAssertEqual(try Authenticity.verifyKey(adk2).hexString, k.s("verify_key_v2"))
        let rot = k.o("rotation")
        let chain = hx(c.s("blob"))
        XCTAssertEqual(Primitives.sha256(chain).hexString, rot.s("chain_blob_sha256"))
        let msg = try Authenticity.rotationMessage(keyVersion: 2, verifyKey: Authenticity.verifyKey(adk2), chainBlob: chain)
        XCTAssertEqual(msg, rot.s("message_utf8"))
        // The vector's (deterministic RFC 8032) signature verifies, and so does this platform's (randomized on Apple).
        XCTAssertTrue(try Authenticity.verify(signature: hx(rot.s("signature")), msg, verifyKey: Authenticity.verifyKey(adk1)))
        XCTAssertFalse(try Authenticity.verify(signature: hx(rot.s("signature")), msg, verifyKey: Authenticity.verifyKey(adk2)))
        XCTAssertTrue(try Authenticity.verify(signature: Authenticity.sign(adk1, msg), msg, verifyKey: Authenticity.verifyKey(adk1)))
        let dk = k.o("device_key")
        let dmsg = try Authenticity.deviceKeyMessage(
            deviceID: dk.s("device_id"),
            keyVersion: dk.i("key_version"),
            publicKey: hx(dk.s("public_key"))
        )
        XCTAssertEqual(dmsg, dk.s("message_utf8"))
        XCTAssertTrue(try Authenticity.verify(signature: hx(dk.s("proof")), dmsg, verifyKey: Authenticity.verifyKey(adk1)))
        let an = k.o("anchor")
        let anchorKey = Authenticity.anchorKey(hx(an.s("recovery_seed")))
        XCTAssertEqual(anchorKey.hexString, an.s("anchor_key"))
        XCTAssertEqual(Authenticity.anchorMessage(hx(k.s("verify_key_v1"))), an.s("message_utf8"))
        XCTAssertEqual(
            Authenticity.recoveryAnchor(anchorKey: anchorKey, verifyKeyV1: hx(k.s("verify_key_v1"))).hexString,
            an.s("recovery_anchor")
        )
        let rk = k.o("recovery_key")
        let rmsg = Authenticity.recoveryKeyMessage(hx(rk.s("public_key")))
        XCTAssertEqual(rmsg, rk.s("message_utf8"))
        XCTAssertTrue(try Authenticity.verify(signature: hx(rk.s("signature")), rmsg, verifyKey: Authenticity.verifyKey(adk1)))
    }

    func testBase64urlIsStrict() throws {
        XCTAssertEqual(B64u.encode([1, 2, 3]), "AQID")
        XCTAssertEqual(try B64u.decode("AQID"), [1, 2, 3])
        XCTAssertEqual(try B64u.decode("__4"), [0xFF, 0xFE])
        for bad in ["AQID=", "AQ+D", "A", "AR"] {
            XCTAssertThrowsError(try B64u.decode(bad), bad) { XCTAssertEqual(($0 as? CryptoError)?.code, "invalid_encoding") }
        }
        let all = (0 ... 255).map { UInt8($0) }
        XCTAssertEqual(try B64u.decode(B64u.encode(all)), all)
    }

    func testTheWordlistIsTheWebOne() throws {
        let web = try String(contentsOf: repoRoot().appendingPathComponent("web/src/lib/crypto/bip39-english.txt"), encoding: .utf8)
            .split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        XCTAssertEqual(Phrase.wordlist, web)
    }

    func testHistoryIDsAreVersion8UUIDs() {
        let id = Items.itemID(fromBytes: Primitives.sha256(Array("x".utf8)))
        XCTAssertTrue(Items.isItemID(id))
        XCTAssertEqual(Array(id)[14], "8")
        XCTAssertTrue("89ab".contains(Array(id)[19]))
    }
}
