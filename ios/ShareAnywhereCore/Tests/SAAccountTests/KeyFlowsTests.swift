import Foundation
@testable import SAAccount
import XCTest

/// The key flows end to end against a simulated server (the account's chain, versions, recovery record and pending
/// blobs, as backend/internal/auth keeps them): setup and recovery with the phrase, pairing, device-key proofs, a
/// rotation picked up by another device, chain import on a device paired later, and refusals for tampered data.
final class KeyFlowsTests: XCTestCase {
    struct Server {
        var versions: [KeyVersionInfo] = []
        var chain: [ChainLink] = []
        var recovery: RecoveryInfo?
        var recoveryBlob: RecoveryBlob?
        var devices: [DeviceKey] = []
        var pending: [String: [PendingBlob]] = [:]
        var keyChain: KeyChain { KeyChain(chain: chain, versions: versions) }
    }

    let deviceA = UUID().uuidString.lowercased()
    let deviceB = UUID().uuidString.lowercased()
    let deviceC = UUID().uuidString.lowercased()

    func setUp(_ server: inout Server, _ store: any KeyStore) async throws -> String {
        let prepared = try await KeyFlows.prepareSetup(store)
        let r = prepared.request
        server.versions = [KeyVersionInfo(keyVersion: 1, verifyKey: r.verifyKey, signature: nil)]
        server.recovery = RecoveryInfo(publicKey: r.recoveryPublicKey, salt: r.salt, params: r.params, signature: r.recoveryKeySignature)
        server.recoveryBlob = RecoveryBlob(
            keyVersion: 1,
            recoveryBlob: r.recoveryBlob,
            salt: r.salt,
            params: r.params,
            recoveryAnchor: r.recoveryAnchor
        )
        try await prepared.commit(store)
        return prepared.phrase
    }

    func pair(_ from: any KeyStore, to: any KeyStore, _ server: Server, trusted: [String?]? = nil) async throws -> Int {
        let ephemeral = Primitives.clamp(Primitives.random(32))
        let pub = try B64u.encode(Primitives.x25519PublicKey(ephemeral))
        let payload = try KeyFlows.pairingPayload(code: "c0de-\(UUID().uuidString.prefix(8))", ephemeralPublicKey: pub)
        let parsed = try XCTUnwrap(KeyFlows.parsePairingPayload(payload))
        let wrap = try await KeyFlows.wrapForPairing(from, ephemeralPublicKey: pub, fingerprint: parsed.fingerprint)
        let ready = PairingStatus(status: "ready", keyVersion: wrap.keyVersion, senderPublicKey: wrap.senderPublicKey, blob: wrap.blob)
        return try await KeyFlows.acceptPairing(
            to, ephemeralPrivate: ephemeral, ready: ready, chain: server.keyChain, trustedSenderKeys: trusted ?? [wrap.senderPublicKey]
        )
    }

    func register(_ server: inout Server, _ store: any KeyStore, _ id: String) async throws {
        let proof = try await KeyFlows.proveDeviceKey(store, deviceID: id)
        server.devices.removeAll { $0.deviceId == id }
        server.devices.append(DeviceKey(deviceId: id, publicKey: proof.publicKey, keyVersion: proof.keyVersion, proof: proof.proof))
    }

    func rotate(_ server: inout Server, _ store: any KeyStore, from id: String, exclude: [String] = []) async throws -> KeyFlows
        .PreparedRotation {
        let current = server.versions.map(\.keyVersion).max() ?? 0
        let r = try await KeyFlows.prepareRotation(
            store, serverKeyVersion: current, recovery: XCTUnwrap(server.recovery), devices: server.devices.filter { $0.deviceId != id },
            exclude: exclude
        )
        let req = r.request
        server.versions.append(KeyVersionInfo(keyVersion: req.keyVersion, verifyKey: req.verifyKey, signature: req.signature))
        server.chain.append(ChainLink(keyVersion: req.keyVersion, blob: req.chainBlob))
        server.recoveryBlob?.keyVersion = req.keyVersion
        server.recoveryBlob?.recoveryBlob = req.recoveryBlob
        for b in req.deviceBlobs {
            server.pending[b.deviceId, default: []].append(PendingBlob(keyVersion: req.keyVersion, blob: b.blob, fromDeviceId: id))
        }
        try await r.commit(store)
        return r
    }

    func testSetupRecoveryPairingRotationAndChainImport() async throws {
        var server = Server()
        let a = MemoryKeyStore(), b = MemoryKeyStore(), c = MemoryKeyStore(), lost = MemoryKeyStore()
        let phrase = try await setUp(&server, a)
        XCTAssertEqual(phrase.split(separator: " ").count, 12)
        let v1 = try await a.adk(1)

        // Recovery with the phrase on a device that has nothing.
        let recovered = try await KeyFlows.recover(
            lost, phrase: phrase, response: XCTUnwrap(server.recoveryBlob), chain: server.keyChain, recoveryKey: server.recovery
        )
        XCTAssertEqual(recovered, 1)
        let lostV1 = try await lost.adk(1)
        XCTAssertEqual(lostV1, v1)

        // Pairing: A wraps its ADK to B's ephemeral key.
        let paired = try await pair(a, to: b, server)
        XCTAssertEqual(paired, 1)
        let bV1 = try await b.adk(1)
        XCTAssertEqual(bV1, v1)
        try await register(&server, a, deviceA)
        try await register(&server, b, deviceB)

        // A rotates to 2; B picks up its pending blob and verifies the rotation link.
        let rotation = try await rotate(&server, a, from: deviceA)
        XCTAssertTrue(rotation.skipped.isEmpty)
        XCTAssertEqual(rotation.request.deviceBlobs.map(\.deviceId), [deviceB])
        let picked = try await KeyFlows.acceptPendingBlobs(b, pending: server.pending[deviceB] ?? [], chain: server.keyChain)
        XCTAssertEqual(picked.accepted, [2])
        XCTAssertEqual(picked.failed, [])
        let aV2 = try await a.adk(2), bV2 = try await b.adk(2)
        XCTAssertEqual(aV2, bV2)

        // C pairs at version 2 and imports version 1 from the chain.
        let cv = try await pair(b, to: c, server)
        XCTAssertEqual(cv, 2)
        let imported = try await KeyFlows.importChain(c, server.keyChain)
        XCTAssertEqual(imported, [1])
        let cV1 = try await c.adk(1)
        XCTAssertEqual(cV1, v1)

        // Recovery after the rotation gives version 2 and anchors on what the device already holds.
        let again = try await KeyFlows.recover(
            lost, phrase: phrase, response: XCTUnwrap(server.recoveryBlob), chain: server.keyChain, recoveryKey: server.recovery
        )
        XCTAssertEqual(again, 2)
    }

    func testRefusals() async throws {
        var server = Server()
        let a = MemoryKeyStore(), b = MemoryKeyStore()
        let phrase = try await setUp(&server, a)

        // A wrong phrase opens nothing.
        let wrong = Phrase.generate()
        await assertCode("recovery_unverified", "decrypt_failed") {
            _ = try await KeyFlows.recover(
                MemoryKeyStore(), phrase: wrong, response: XCTUnwrap(server.recoveryBlob), chain: server.keyChain,
                recoveryKey: server.recovery
            )
        }
        // A server that swaps the first verify key cannot pass the recovery anchor.
        var forged = server
        forged.versions[0].verifyKey = try B64u.encode(Authenticity.verifyKey(Primitives.random(32)))
        await assertCode("recovery_unverified") {
            _ = try await KeyFlows.recover(
                MemoryKeyStore(), phrase: phrase, response: XCTUnwrap(forged.recoveryBlob), chain: forged.keyChain,
                recoveryKey: forged.recovery
            )
        }
        // Pairing from a key that is not one of the account's devices is refused.
        await assertCode("untrusted_sender") { _ = try await self.pair(a, to: b, server, trusted: ["someone-else"]) }
        // A scanned code whose fingerprint does not match the key.
        let other = try B64u.encode(Primitives.x25519PublicKey(Primitives.clamp(Primitives.random(32))))
        await assertCode("untrusted_sender") {
            _ = try await KeyFlows.wrapForPairing(a, ephemeralPublicKey: other, fingerprint: B64u.encode(Array(repeating: 0, count: 16)))
        }

        // A tampered rotation signature does not verify on pickup or chain walk.
        _ = try await pair(a, to: b, server)
        try await register(&server, b, deviceB)
        _ = try await rotate(&server, a, from: deviceA)
        var tampered = server
        tampered.versions[1].signature = B64u.encode(Array(repeating: 1, count: 64))
        await assertCode("unverified") { try Verify.verifySignatureChain(tampered.keyChain, upTo: 2) }
        // A rotation to devices with a stale proof skips them.
        var stale = server
        stale.devices = [DeviceKey(
            deviceId: deviceC,
            publicKey: server.devices[0].publicKey,
            keyVersion: 1,
            proof: server.devices[0].proof
        )]
        let r = try await KeyFlows.prepareRotation(a, serverKeyVersion: 2, recovery: XCTUnwrap(stale.recovery), devices: stale.devices)
        XCTAssertEqual(r.skipped.map(\.reason), [.stale])
        r.discard()
        // Legacy accounts (no recovery-key signature) refuse to rotate.
        var legacyServer = server
        legacyServer.recovery?.signature = nil
        await assertCode("keys_legacy") {
            _ = try await KeyFlows.prepareRotation(a, serverKeyVersion: 2, recovery: XCTUnwrap(legacyServer.recovery), devices: [])
        }
    }

    func testPairingPayloadParsing() throws {
        let pub = try B64u.encode(Primitives.x25519PublicKey(Primitives.clamp(Primitives.random(32))))
        let payload = try KeyFlows.pairingPayload(code: "abc_DEF-123", ephemeralPublicKey: pub)
        XCTAssertTrue(payload.hasPrefix("sa1.abc_DEF-123."))
        XCTAssertEqual(KeyFlows.parsePairingPayload("  \(payload)\n")?.code, "abc_DEF-123")
        XCTAssertNil(try KeyFlows.parsePairingPayload("sa2.abc.\(KeyFlows.pairingFingerprint(pub))"))
        XCTAssertNil(try KeyFlows.parsePairingPayload("sa1.a b.\(KeyFlows.pairingFingerprint(pub))"))
        XCTAssertNil(KeyFlows.parsePairingPayload("sa1.abc.short"))
    }

    func assertCode(_ codes: String..., file: StaticString = #filePath, line: UInt = #line, _ body: () async throws -> Void) async {
        do {
            try await body()
            XCTFail("expected \(codes)", file: file, line: line)
        } catch let e as CryptoError {
            XCTAssertTrue(codes.contains(e.code), "got \(e.code), expected \(codes)", file: file, line: line)
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
    }
}
