import CryptoKit
import Foundation
import SATransferRuntime
import XCTest

/// The other device in a UI test: a second anonymous identity in the test runner (its own process on the same
/// simulator) with the same runtime and WebRTC adapter as the app, talking to the native CI backend. It joins the app's
/// session as a receiver, or shares files the app receives (docs/phases/PHASE_7_IOS.md, as Android's TestPeer).
final class TestPeer: @unchecked Sendable {
    let identity: IdentityManager
    let services: LiveServices
    let socket: SessionSocket
    let dir: URL
    private var controllers: [AnyObject] = []

    private final class Secrets: SecretStore, @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?
        func read() async throws -> String? { lock.locked { value } }
        func write(_ secret: String) async throws { lock.locked { value = secret } }
        func clear() async throws { lock.locked { value = nil } }
    }

    static var backend: URL { URL(string: UITest.backendURL)! }

    init() throws {
        let client = try APIClient(baseURL: TestPeer.backend, requireHTTPS: false, userAgent: "ShareAnywhere-UITest-Peer")
        identity = IdentityManager(api: DeviceAPI(client: client), store: Secrets(), platform: "ios")
        let services = LiveServices(client: client, identity: identity)
        self.services = services
        socket = SessionSocket(
            baseURL: TestPeer.backend,
            connector: URLSessionWebSocketConnector(),
            ticket: { try await services.wsTicket().ticket }
        )
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("peer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    /// Creates the identity and names the device (the name the app shows on the participant card).
    func ready(name: String) async throws {
        _ = try await identity.accessToken()
        _ = try await identity.rename(name)
    }

    // MARK: Receiving from the app

    func join(code: String) async throws -> JoinResult {
        let preview = try await services.resolveCode(code)
        return try await services.join(sessionId: preview.sessionId, ticket: preview.joinTicket)
    }

    /// Starts receiving into the peer's temporary folder; returns the controller to watch. With `choose: false` it loads
    /// (and, with `cloud`, learns the session's cloud objects and asks for their keys) without starting; `choose(_:)`
    /// starts it later. `peers` replaces the WebRTC factory (a factory that refuses stands for "no network path").
    func receive(
        _ sessionId: String, choose: Bool = true, cloud: Bool = false, peers: (any PeerFactory)? = nil
    ) async -> ReceiverController {
        let inbox = dir.appendingPathComponent("inbox-\(sessionId.prefix(8))")
        var deps = ReceiverDeps(
            sessionId: sessionId, sessions: services, transfers: services, socket: socket, peers: peers ?? WebRTCPeerFactory.shared,
            targets: JSONMap(url: dir.appendingPathComponent("targets.json")),
            saved: JSONMap(url: dir.appendingPathComponent("saved.json")),
            history: nil, resolveFolder: { _ in ScopedFolder(url: inbox) }
        )
        if cloud { deps.cloud = services }
        let c = ReceiverController(deps)
        controllers.append(c)
        await c.start()
        await c.loaded()
        if choose { await c.choose(SaveTarget(kind: .documents, label: "peer")) }
        return c
    }

    // MARK: Sending to the app

    /// Shares one generated file; returns the session (with its code), the file's SHA-256 and the sender controller,
    /// not started yet (`start()` it to serve the app; until then the app's offers find nobody).
    func share(
        name: String, size: Int, requireApproval: Bool = false, relayOnly: Bool = false
    ) async throws -> (SessionView, String, SenderController) {
        let url = dir.appendingPathComponent(name)
        let bytes = TestPeer.content(size: size, seed: 11)
        try Data(bytes).write(to: url)
        let view = try await services.create(
            files: [FileInput(name: name, size: Int64(size), mime: "application/octet-stream")], requireApproval: requireApproval
        )
        let outgoing = JSONMap<[OutgoingFile]>(url: dir.appendingPathComponent("outgoing-\(view.id).json"))
        let file = try XCTUnwrap(view.files?.first)
        try await outgoing.put(view.id, [OutgoingFile(fileId: file.id, size: file.size, locator: Data(url.path.utf8))])
        let c = SenderController(SenderDeps(
            sessionId: view.id, sessions: services, transfers: services, socket: socket,
            peers: relayOnly ? RelayOnlyPeers() : WebRTCPeerFactory.shared, outgoing: outgoing, history: nil,
            openSource: { f in FileReadSource(url: URL(fileURLWithPath: String(decoding: f.locator, as: UTF8.self)), size: f.size) }
        ))
        controllers.append(c)
        return (view, TestPeer.sha256(bytes), c)
    }

    func close(_ sessionId: String) async { try? await services.close(sessionId) }

    func dispose() async {
        for c in controllers {
            if let s = c as? SenderController { await s.dispose() }
            if let r = c as? ReceiverController { await r.dispose() }
        }
        controllers.removeAll()
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: Helpers

    /// Moves the test backend's clock (testhooks build, SA_ENV=test) and runs its expiry jobs.
    static func advanceClock(seconds: Int) async throws {
        var req = URLRequest(url: backend.appendingPathComponent("v1/_test/clock"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(#"{"advance_seconds":\#(seconds)}"#.utf8)
        let (_, res) = try await URLSession.shared.data(for: req)
        XCTAssertEqual((res as? HTTPURLResponse)?.statusCode, 200, "clock hook")
    }

    /// The app's seeded send files (`-seedSendFiles`): the same bytes as `SendView.seedContent`.
    static func seededContent(index: Int, size: Int) -> [UInt8] {
        var block = [UInt8](repeating: 0, count: 65536)
        for j in 0 ..< block.count {
            block[j] = UInt8(truncatingIfNeeded: (j &* 31) ^ (index &* 7) ^ (j >> 9))
        }
        return stamped(block, size: size)
    }

    /// Pseudo-random content: one random-looking 64 KiB block, stamped with each block's index.
    static func content(size: Int, seed: UInt32) -> [UInt8] {
        var x: UInt32 = 2_463_534_242 ^ seed
        var block = [UInt8](repeating: 0, count: 65536)
        for i in 0 ..< block.count {
            x ^= x << 13
            x ^= x >> 17
            x ^= x << 5
            block[i] = UInt8(truncatingIfNeeded: x)
        }
        return stamped(block, size: size)
    }

    private static func stamped(_ block: [UInt8], size: Int) -> [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(size)
        var k: UInt64 = 0
        while out.count < size {
            var b = block
            withUnsafeBytes(of: k.littleEndian) { stamp in
                for (i, byte) in stamp.enumerated() {
                    b[i] ^= byte
                }
            }
            out.append(contentsOf: b.prefix(size - out.count))
            k += 1
        }
        return out
    }

    static func sha256(_ bytes: [UInt8]) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

    static func sha256(file: URL) -> String? { (try? Data(contentsOf: file)).map { sha256([UInt8]($0)) } }
}

/// Runs async work from a synchronous XCTest method with a deadline.
extension XCTestCase {
    func blocking<T: Sendable>(_ timeout: TimeInterval = 60, _ body: @escaping @Sendable () async throws -> T) throws -> T {
        let done = expectation(description: "async")
        let box = ResultBox<T>()
        Task {
            do { try await box.set(.success(body())) } catch { box.set(.failure(error)) }
            done.fulfill()
        }
        wait(for: [done], timeout: timeout)
        guard let result = box.get() else {
            XCTFail("async work did not finish in \(Int(timeout)) s")
            throw TimedOut()
        }
        return try result.get()
    }

    /// Polls `check` until it holds (the app and the peer move on their own).
    func eventually(_ what: String, timeout: TimeInterval = 60, _ check: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if check() { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTFail("timed out: \(what)")
    }
}

/// Forced relay (docs/ADR/0029): this side gathers TURN relay candidates only, as the app does on a relay policy step;
/// libwebrtc gathers no loopback host candidates, so on one machine coturn bridges two relay candidates. The CI
/// coturn's self-signed TLS certificate is accepted (Debug test runner only).
struct RelayOnlyPeers: PeerFactory {
    func make(iceServers: [ICEServer], relayOnly _: Bool, callbacks: PeerCallbacks) async throws -> any PeerLink {
        WebRTCPeerFactory.shared.allowInsecureTurnTLS(true)
        return try await WebRTCPeerFactory.shared.make(iceServers: iceServers, relayOnly: true, callbacks: callbacks)
    }
}

/// No peer connection can be made (the receiver's network path to the sender is gone), so only Cloud can deliver.
struct NoPeers: PeerFactory {
    func make(iceServers _: [ICEServer], relayOnly _: Bool, callbacks _: PeerCallbacks) async throws -> any PeerLink { throw TimedOut() }
}

struct TimedOut: Error {}

final class ResultBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<T, any Error>?
    func set(_ v: Result<T, any Error>) { lock.locked { value = v } }
    func get() -> Result<T, any Error>? { lock.locked { value } }
}
