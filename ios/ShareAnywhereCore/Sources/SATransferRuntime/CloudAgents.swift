import Crypto
import Foundation

public enum CloudUploadStatus: String, Sendable, Equatable {
    case waiting, uploading, ready, paused, failed
}

public struct CloudUploadFile: Sendable, Equatable, Identifiable {
    public var fileId: String
    public var name: String
    public var size: Int64
    /// Plaintext bytes encrypted and stored so far.
    public var uploaded: Int64
    public var status: CloudUploadStatus
    public var id: String { fileId }
}

public struct CloudUploadState: Sendable, Equatable {
    public var files: [CloudUploadFile] = []
    /// Catalog key of the error that stopped or paused the upload (budget, consent, network), or nil.
    public var error: String?
    public init() {}

    public var ready: Bool { !files.isEmpty && files.allSatisfy { $0.status == .ready } }
    public var paused: Bool { files.contains { $0.status == .paused } }
}

let cloudErrorKeys = [
    "cloud_budget_exhausted": "product.cloud_budget_exhausted",
    "cloud_consent_required": "product.cloud_consent_needed",
    "cloud_requires_account": "product.cloud_signin",
    "cloud_unavailable": "product.cloud_unavailable"
]

/// The sender side of Cloud Distribution (docs/TRANSFER_PROTOCOL.md §9), the iOS twin of the Web's `CloudUploader`:
/// distributes each file, encrypts it part by part under a fresh key, uploads and seals, and answers receivers'
/// CLOUD_KEY_REQUEST with the keys wrapped to their ephemeral X25519 keys. Keys stay in memory: once sealed, receivers
/// can finish while this app is in the background or suspended.
public actor CloudUploader {
    public struct File: Sendable {
        public let fileId: String
        public let name: String
        public let size: Int64
        public let source: any FileSource

        public init(fileId: String, name: String, size: Int64, source: any FileSource) {
            self.fileId = fileId
            self.name = name
            self.size = size
            self.source = source
        }
    }

    public nonisolated let state = StateCell(CloudUploadState())
    private let sessionId: String
    private let api: any CloudService
    private let socket: SessionSocket
    private let files: [File]
    private let sleep: Sleeper
    private var keys: [String: CloudObjectKey] = [:]
    private var ready: Set<String> = []
    private var stopped = false
    private var eventsTask: Task<Void, Never>?
    private var resumed: [CheckedContinuation<Void, Never>] = []

    public init(sessionId: String, api: any CloudService, socket: SessionSocket, files: [File], sleep: @escaping Sleeper = systemSleeper) {
        self.sessionId = sessionId
        self.api = api
        self.socket = socket
        self.files = files
        self.sleep = sleep
        var s = CloudUploadState()
        s.files = files.map { CloudUploadFile(fileId: $0.fileId, name: $0.name, size: $0.size, uploaded: 0, status: .waiting) }
        state.set(s)
    }

    /// Uploads every file in order; returns when all are sealed or the upload stopped.
    public func start() async {
        let events = socket.events()
        eventsTask = Task { [weak self] in
            for await e in events {
                await self?.onSocket(e)
            }
        }
        for f in files {
            if stopped { return }
            do {
                try await upload(f)
            } catch {
                let code = (error as? APIError)?.code ?? "network"
                patch(f.fileId) { $0.status = .failed }
                state.update { $0.error = cloudErrorKeys[code] ?? "product.cloud_upload_failed" }
                return
            }
        }
    }

    public func dispose() {
        stopped = true
        eventsTask?.cancel()
        wake()
    }

    private func wake() {
        let all = resumed
        resumed.removeAll()
        for c in all {
            c.resume()
        }
    }

    private func patch(_ fileId: String, _ f: (inout CloudUploadFile) -> Void) {
        state.update { s in if let i = s.files.firstIndex(where: { $0.fileId == fileId }) { f(&s.files[i]) } }
    }

    private func upload(_ f: File) async throws {
        var o = try await api.distribute(fileId: f.fileId)
        guard o.status == "UPLOADING" else {
            // An object from an earlier run whose key this app no longer holds: receivers keep P2P for this file.
            patch(f.fileId) { $0.status = .failed }
            return
        }
        patch(f.fileId) { $0.status = .uploading }
        let key = CloudCrypto.newFileKey()
        var hasher = StreamHasher()
        for n in 0 ..< o.partCount {
            if stopped { return }
            let off = Int64(n) * Int64(o.partSize)
            let len = Int(max(0, min(Int64(o.partSize), f.size - off)))
            let plain = len > 0 ? try await f.source.read(offset: off, length: len) : []
            hasher.update(offset: off, plain)
            let stored = try CloudCrypto.sealPart(key: key, objectId: o.id, n: n, count: o.partCount, plaintext: plain)
            o = try await put(fileId: f.fileId, objectId: o.id, n: n, stored: stored)
            patch(f.fileId) {
                $0.uploaded = off + Int64(len)
                $0.status = .uploading
            }
        }
        o = try await api.seal(objectId: o.id)
        keys[o.id] = CloudObjectKey(objectId: o.id, fileId: f.fileId, key: key, sha256: hexBytes(hasher.hex()))
        ready.insert(o.id)
        patch(f.fileId) {
            $0.status = .ready
            $0.uploaded = f.size
        }
    }

    /// One part: retries network errors with backoff; waits out a used-up budget until CLOUD_UPDATED lifts it.
    private func put(fileId: String, objectId: String, n: Int, stored: [UInt8]) async throws -> CloudObject {
        var attempt = 0
        while true {
            do {
                let o = try await api.putPart(objectId: objectId, n: n, bytes: stored)
                if state.value.error != nil { state.update { $0.error = nil } }
                return o
            } catch let e as APIError where e.code == "cloud_budget_exhausted" {
                if stopped { throw e }
                patch(fileId) { $0.status = .paused }
                state.update { $0.error = cloudErrorKeys[e.code] }
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    resumed.append(c)
                    Task { [weak self, sleep] in
                        await sleep(60000)
                        await self?.wake()
                    }
                }
            } catch let e as APIError where e.status < 500 && e.status != 429 {
                throw e
            } catch {
                if stopped { throw error }
                await sleep(min(15000, 1000 << Int64(min(attempt, 4))))
                attempt += 1
            }
        }
    }

    private func onSocket(_ e: SocketEvent) async {
        guard e.sessionId == sessionId else { return }
        switch e.type {
        case "CLOUD_UPDATED":
            if let o = e.decode("object", as: CloudObject.self), !o.paused { wake() }
        case "CLOUD_KEY_REQUEST":
            // The server relays this only from a JOINED receiver of this session (docs/API.md §4).
            guard let from = e.from, let req = e.decode("payload", as: CloudKeyRequestPayload.self) else { return }
            let ks = keys.values.filter { ready.contains($0.objectId) }.sorted { $0.objectId < $1.objectId }
            guard !ks.isEmpty,
                  let payload = try? CloudCrypto.wrapKeys(ks, receiverPublic: req.publicKey, sessionId: sessionId, receiverPid: from),
                  let m = signalMessage(type: "CLOUD_KEY", sessionId: sessionId, to: from, payload: payload) else { return }
            _ = socket.send(m)
        default:
            break
        }
    }
}

/// The receiver side of Cloud Distribution (docs/TRANSFER_PROTOCOL.md §9), the iOS twin of the Web's `CloudReceive`.
public actor CloudReceive {
    private let sessionId: String
    private let participantId: String
    private let senderPid: String
    private let api: any CloudService
    private let socket: SessionSocket
    private let clock: MillisClock
    private let onChange: @Sendable () -> Void
    private var objects: [String: CloudObject] = [:] // by file id
    private var keys: [String: CloudObjectKey] = [:] // by object id
    private var eph: Curve25519.KeyAgreement.PrivateKey?
    private var lastAsk: Int64 = .min / 2
    /// Per file: the next part to fetch and the hash of the parts before it, so a retry resumes (§9).
    private var cursors: [String: (next: Int, hasher: StreamHasher)] = [:]

    /// Whether a download of this file stopped part-way and can resume (its parts so far are in the partial file).
    public func resumable(_ fileId: String) -> Bool { (cursors[fileId]?.next ?? 0) > 0 }

    /// Forgets a stopped download's cursor: the caller starts a new partial file, so the next download starts at part 0.
    public func restart(_ fileId: String) { cursors[fileId] = nil }
    private var eventsTask: Task<Void, Never>?

    public init(
        sessionId: String, participantId: String, senderPid: String, api: any CloudService, socket: SessionSocket,
        clock: @escaping MillisClock = systemClock, onChange: @escaping @Sendable () -> Void
    ) {
        self.sessionId = sessionId
        self.participantId = participantId
        self.senderPid = senderPid
        self.api = api
        self.socket = socket
        self.clock = clock
        self.onChange = onChange
    }

    public func start() async {
        let events = socket.events()
        eventsTask = Task { [weak self] in
            for await e in events {
                await self?.onSocket(e)
            }
        }
        await refresh()
    }

    /// Loads the session's objects and asks for missing keys (at start and after every socket (re)connect).
    private func refresh() async {
        if let list = try? await api.cloudObjects(sessionId: sessionId) {
            for o in list {
                objects[o.fileId] = o
            }
        }
        askForKeys()
        onChange()
    }

    public func dispose() { eventsTask?.cancel() }

    /// A READY, unpaused object whose key this receiver holds.
    public func ready(_ fileId: String) -> Bool {
        guard let o = objects[fileId] else { return false }
        return o.status == "READY" && !o.paused && keys[o.id] != nil
    }

    private func onSocket(_ e: SocketEvent) {
        if e.type == "SOCKET_OPEN" {
            // A request sent while the socket was down was dropped: ask again now, without waiting out the 10 s.
            lastAsk = .min / 2
            Task { await self.refresh() }
            return
        }
        guard e.sessionId == sessionId else { return }
        if e.type == "CLOUD_UPDATED", let o = e.decode("object", as: CloudObject.self) {
            if o.status == "DELETED" { objects[o.fileId] = nil } else { objects[o.fileId] = o }
            askForKeys()
            onChange()
        } else if e.type == "CLOUD_KEY", e.from == senderPid, let eph, let payload = e.decode("payload", as: CloudKeyPayload.self) {
            for k in CloudCrypto.unwrapKeys(payload, receiver: eph, sessionId: sessionId, receiverPid: participantId) {
                keys[k.objectId] = k
            }
            onChange()
        }
    }

    /// Asks the sender for keys when a READY object lacks one (at most once every 10 s).
    public func askForKeys() {
        let missing = objects.values.contains { $0.status == "READY" && keys[$0.id] == nil }
        guard missing, clock() - lastAsk >= 10000 else { return }
        let k = eph ?? Curve25519.KeyAgreement.PrivateKey()
        eph = k
        // Only a request that went out starts the 10 s wait; SOCKET_OPEN retries one that could not be sent.
        if let m = signalMessage(
            type: "CLOUD_KEY_REQUEST", sessionId: sessionId, to: senderPid,
            payload: CloudKeyRequestPayload(publicKey: b64uEncode([UInt8](k.publicKey.rawRepresentation)))
        ), socket.send(m) {
            lastAsk = clock()
        }
    }

    /// Downloads and decrypts one file in order, writing each part at its offset, then checks the whole-file SHA-256
    /// and tells the server this receiver has it.
    public func download(
        _ fileId: String, write: @Sendable (Int64, [UInt8]) async throws -> Void, progress: @Sendable (Int64) async -> Void,
        stopped: @Sendable () async -> Bool
    ) async throws {
        guard let o = objects[fileId], let k = keys[o.id] else { throw CloudError.unavailable }
        var hasher = cursors[fileId]?.hasher ?? StreamHasher()
        let start = cursors[fileId]?.next ?? 0
        for n in start ..< o.partCount {
            if await stopped() { throw CloudError.network }
            let stored: [UInt8]
            do {
                stored = try await api.getPart(objectId: o.id, n: n)
            } catch let e as APIError where e.code == "cloud_budget_exhausted" {
                throw CloudError.paused
            } catch let e as APIError where e.status == 404 || e.status == 409 {
                throw CloudError.unavailable
            } catch {
                throw CloudError.network
            }
            let plain: [UInt8]
            do {
                plain = try CloudCrypto.openPart(key: k.key, objectId: o.id, n: n, count: o.partCount, stored: stored)
            } catch {
                cursors[fileId] = nil
                throw error
            }
            let off = Int64(n) * Int64(o.partSize)
            try await write(off, plain)
            hasher.update(offset: off, plain)
            cursors[fileId] = (n + 1, hasher)
            await progress(off + Int64(plain.count))
        }
        cursors[fileId] = nil
        guard hexBytes(hasher.hex()) == k.sha256 else { throw CloudError.integrity }
        _ = try? await api.received(objectId: o.id)
    }
}

func hexBytes(_ s: String) -> [UInt8] {
    var out: [UInt8] = []
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        out.append(UInt8(s[i ..< j], radix: 16) ?? 0)
        i = j
    }
    return out
}
