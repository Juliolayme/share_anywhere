import Foundation
@testable import SAAPIClient
@testable import SATransferRuntime

/// A text queue one reader awaits.
final class AsyncQueue<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: [T] = []
    private var waiter: CheckedContinuation<T?, Never>?
    private var finished = false

    func push(_ v: T) {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        if let w = waiter {
            waiter = nil
            lock.unlock()
            w.resume(returning: v)
        } else {
            buffer.append(v)
            lock.unlock()
        }
    }

    func finish() {
        lock.lock()
        finished = true
        let w = waiter
        waiter = nil
        lock.unlock()
        w?.resume(returning: nil)
    }

    func next() async -> T? {
        await withCheckedContinuation { c in
            lock.lock()
            if !buffer.isEmpty {
                let v = buffer.removeFirst()
                lock.unlock()
                c.resume(returning: v)
            } else if finished {
                lock.unlock()
                c.resume(returning: nil)
            } else {
                waiter = c
                lock.unlock()
            }
        }
    }
}

struct FakeError: Error {}

/// An in-memory backend with the same rules the controllers rely on: participants and capability hashes, transfer
/// records validated against the state machine, TRANSFER_UPDATED and PARTICIPANT_* events, and signaling relayed
/// between the sender's and receivers' sockets with `from` set to the caller's participant id.
final class FakeBackend: @unchecked Sendable {
    /// Test hook: TURN credentials are refused with relay_cap_reached.
    var relayCapped = false
    /// Cloud Distribution (docs/API.md §2.6): objects by id and stored parts by "<object>/<n>", part size 1 MiB.
    var cloudObjects: [String: CloudObject] = [:]
    var cloudParts: [String: [UInt8]] = [:]
    var cloudPartSize = 1 << 20
    struct Member {
        var participant: Participant
        var device: String
        var capability: String
    }

    struct Session {
        var id: String
        var senderDevice: String
        var senderPid: String
        var files: [SharedFile]
        var members: [Member] = []
        var transfers: [Transfer] = []
        var status = "WAITING"
    }

    fileprivate let lock = NSLock()
    private var sessions: [String: Session] = [:]
    private var sockets: [String: [AsyncQueue<String>]] = [:]
    private(set) var reports: [(String, String)] = []
    private(set) var rejectedReports: [(String, String, String)] = []
    var log: [String] { lock.locked { reports.map { "\($0.0):\($0.1)" } } }

    func client(_ device: String) -> FakeClient { FakeClient(backend: self, device: device) }

    // MARK: setup

    func createSession(device: String, files: [(String, Int64)]) -> String {
        let id = UUID().uuidString.lowercased()
        let shared = files.map { SharedFile(id: UUID().uuidString.lowercased(), name: $0.0, size: $0.1, mime: "application/octet-stream") }
        lock.locked { sessions[id] = Session(id: id, senderDevice: device, senderPid: UUID().uuidString.lowercased(), files: shared) }
        return id
    }

    /// A receiver joins (open join): one transfer per file.
    func join(_ sessionId: String, device: String, name: String) -> String {
        let pid = UUID().uuidString.lowercased()
        let p = Participant(
            id: pid, role: "receiver", status: "JOINED", displayName: name, platform: "ios", signedIn: false,
            securityWords: ["amber", "breeze", "cedar"], joinedVia: "code", requestReason: nil, joinedAt: nil
        )
        let event: [String: JSONValue] = lock.locked {
            var s = sessions[sessionId]!
            s.members.append(Member(participant: p, device: device, capability: "cap-\(UUID().uuidString)"))
            for f in s.files {
                s.transfers.append(Transfer(
                    id: UUID().uuidString.lowercased(), sessionId: sessionId, participantId: pid, fileId: f.id, status: "PENDING",
                    verifiedBytes: 0, size: f.size, updatedAt: "2026-01-01T00:00:00Z"
                ))
            }
            s.status = "ACTIVE"
            sessions[sessionId] = s
            return ["type": .string("PARTICIPANT_JOINED"), "session_id": .string(sessionId), "participant": Self.json(p)]
        }
        push(to: senderDevice(sessionId), event)
        return pid
    }

    func setParticipant(_ sessionId: String, _ pid: String, status: String) {
        let (event, devices): ([String: JSONValue], [String]) = lock.locked {
            var s = sessions[sessionId]!
            let i = s.members.firstIndex { $0.participant.id == pid }!
            s.members[i].participant.status = status
            sessions[sessionId] = s
            let type = status == "BLOCKED" ? "PARTICIPANT_BLOCKED" : "PARTICIPANT_REMOVED"
            return (
                ["type": .string(type), "session_id": .string(sessionId), "participant": Self.json(s.members[i].participant)],
                [s.senderDevice, s.members[i].device]
            )
        }
        for d in devices {
            push(to: d, event)
        }
    }

    func transfers(_ sessionId: String) -> [Transfer] { lock.locked { sessions[sessionId]!.transfers } }

    private func senderDevice(_ sessionId: String) -> String { lock.locked { sessions[sessionId]!.senderDevice } }

    static func json(_ v: some Encodable) -> JSONValue {
        guard let data = try? APIClient.encoder.encode(v), let value = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            return .null
        }
        return value
    }

    // MARK: sockets

    func connect(device: String) -> AsyncQueue<String> {
        let q = AsyncQueue<String>()
        lock.locked { sockets[device, default: []].append(q) }
        q.push(#"{"type":"WELCOME","device_id":"\#(device)","server_time":"2026-01-01T00:00:00Z"}"#)
        return q
    }

    func disconnect(device: String, _ q: AsyncQueue<String>) {
        lock.locked { sockets[device]?.removeAll { $0 === q } }
        q.finish()
    }

    func push(to device: String, _ event: [String: JSONValue]) {
        guard let data = try? JSONEncoder().encode(event), let text = String(data: data, encoding: .utf8) else { return }
        for q in lock.locked({ sockets[device] ?? [] }) {
            q.push(text)
        }
    }

    /// A client message: relay signaling to the addressed participant.
    func received(_ text: String, from device: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data),
              case let .string(type)? = obj["type"], case let .string(sid)? = obj["session_id"],
              case let .string(to)? = obj["to"], let payload = obj["payload"] else { return }
        let route: (String, String)? = lock.locked {
            guard let s = sessions[sid] else { return nil }
            let fromPid = s.senderDevice == device ? s.senderPid : s.members.first { $0.device == device }?.participant.id
            guard let fromPid else { return nil }
            if to == s.senderPid { return (s.senderDevice, fromPid) }
            guard let m = s.members.first(where: { $0.participant.id == to && $0.participant.status == "JOINED" }) else { return nil }
            return (m.device, fromPid)
        }
        guard let (dest, fromPid) = route else { return }
        push(to: dest, ["type": .string(type), "session_id": .string(sid), "from": .string(fromPid), "payload": payload])
    }

    // MARK: API

    func view(_ id: String, device: String) throws -> SessionView {
        try lock.locked {
            guard let s = sessions[id]
            else { throw APIError(status: 404, code: "not_found", message: "", retryAfterSeconds: nil, body: nil) }
            let isSender = s.senderDevice == device
            let me = s.members.first { $0.device == device }
            if !isSender, me == nil { throw APIError(status: 403, code: "forbidden", message: "", retryAfterSeconds: nil, body: nil) }
            return SessionView(
                id: id, role: isSender ? "sender" : "receiver", status: s.status, requireApproval: false, joinWindow: nil,
                code: nil, linkToken: nil, joinUrl: nil, capacity: nil, participants: isSender ? s.members.map(\.participant) : nil,
                sender: PeerSummary(participantId: s.senderPid, displayName: "Sender iPhone", platform: "ios", signedIn: false),
                me: me?.participant, files: s.files, totalBytes: s.files.reduce(0) { $0 + $1.size }, fileCount: s.files.count,
                protectedMode: false, expiresAt: "2026-01-01T00:00:00Z", serverTime: "2026-01-01T00:00:00Z"
            )
        }
    }

    func list(_ id: String, device: String) -> TransferList {
        lock.locked {
            let s = sessions[id]!
            if s.senderDevice == device {
                let peers = s.members.map {
                    TransferPeer(participantId: $0.participant.id, status: $0.participant.status, capabilityHash: sha256Hex($0.capability))
                }
                return TransferList(role: "sender", transfers: s.transfers, peers: peers, capability: nil, serverTime: "")
            }
            let me = s.members.first { $0.device == device }!
            return TransferList(
                role: "receiver", transfers: s.transfers.filter { $0.participantId == me.participant.id }, peers: nil,
                capability: me.capability, serverTime: ""
            )
        }
    }

    func setStatus(_ transferId: String, _ status: String, bytes: Int64?, validate: Bool, device _: String) throws -> Transfer {
        let (t, devices): (Transfer, [String]) = try lock.locked {
            for (sid, var s) in sessions {
                guard let i = s.transfers.firstIndex(where: { $0.id == transferId }) else { continue }
                var t = s.transfers[i]
                let allowed = t.status == status || (Transitions.next[t.status] ?? []).contains(status)
                if validate, !allowed {
                    rejectedReports.append((transferId, t.status, status))
                    throw APIError(status: 409, code: "invalid_transition", message: "", retryAfterSeconds: nil, body: nil)
                }
                if Transitions.terminal(t.status) { return (t, []) }
                t.status = status
                if let bytes { t.verifiedBytes = max(t.verifiedBytes, bytes) }
                s.transfers[i] = t
                sessions[sid] = s
                reports.append((transferId, status))
                let receiver = s.members.first { $0.participant.id == t.participantId }?.device
                return (t, [s.senderDevice] + (receiver.map { [$0] } ?? []))
            }
            throw APIError(status: 404, code: "not_found", message: "", retryAfterSeconds: nil, body: nil)
        }
        let event: [String: JSONValue] = ["type": .string("TRANSFER_UPDATED"), "session_id": .string(t.sessionId), "transfer": Self.json(t)]
        for d in Set(devices) {
            push(to: d, event)
        }
        return t
    }

    func close(_ id: String) {
        let devices: [String] = lock.locked {
            var s = sessions[id]!
            s.status = "CLOSED"
            sessions[id] = s
            return [s.senderDevice] + s.members.map(\.device)
        }
        for d in devices {
            push(to: d, ["type": .string("SESSION_CLOSED"), "session_id": .string(id), "reason": .string("closed")])
        }
    }
}

/// One device's view of the fake backend.
struct FakeClient: SessionService, TransferService, WebSocketConnector {
    let backend: FakeBackend
    let device: String

    func create(files _: [FileInput], requireApproval _: Bool) async throws -> SessionView { throw FakeError() }
    func listOpen() async throws -> OpenSessionList { throw FakeError() }
    func get(_ id: String) async throws -> SessionView { try backend.view(id, device: device) }
    func update(_: String, _: UpdateSessionRequest) async throws -> SessionView { throw FakeError() }
    func renew(_: String) async throws -> SessionView { throw FakeError() }
    func close(_ id: String) async throws { backend.close(id) }
    func resolveCode(_: String) async throws -> JoinPreview { throw FakeError() }
    func resolveLink(_: String) async throws -> JoinPreview { throw FakeError() }
    func join(sessionId _: String, ticket _: String) async throws -> JoinResult { throw FakeError() }
    func decide(participantId _: String, _: Decision) async throws -> Participant { throw FakeError() }
    func remove(participantId _: String) async throws -> Participant { throw FakeError() }
    func wsTicket() async throws -> WsTicket { WsTicket(ticket: "t", expiresIn: 30) }

    func list(sessionId: String) async throws -> TransferList { backend.list(sessionId, device: device) }

    func report(transferId: String, status: String, verifiedBytes: Int64, route _: String?) async throws -> Transfer {
        try backend.setStatus(transferId, status, bytes: verifiedBytes, validate: true, device: device)
    }

    func action(transferId: String, _ kind: TransferActionKind, capability _: String?) async throws -> Transfer {
        let status = switch kind {
        case .pause: "PAUSED"
        case .resume: "RESUMING"
        case .cancel: "CANCELLED"
        }
        return try backend.setStatus(transferId, status, bytes: nil, validate: false, device: device)
    }

    func turn(sessionId _: String) async throws -> TurnCredentials {
        if backend.relayCapped {
            throw APIError(status: 403, code: "relay_cap_reached", message: "", retryAfterSeconds: nil, body: nil)
        }
        return TurnCredentials(
            username: "u", credential: "c", uris: ["turn:t:3478?transport=udp", "turns:t:5349?transport=tcp"], ttl: 1800,
            expiresAt: "2099-01-01T00:00:00Z"
        )
    }

    func connect(_: URL) -> any WebSocketConnection {
        FakeSocketConnection(backend: backend, device: device, inbox: backend.connect(device: device))
    }
}

final class FakeSocketConnection: WebSocketConnection, @unchecked Sendable {
    let backend: FakeBackend
    let device: String
    let inbox: AsyncQueue<String>

    init(backend: FakeBackend, device: String, inbox: AsyncQueue<String>) {
        self.backend = backend
        self.device = device
        self.inbox = inbox
    }

    func receive() async throws -> String {
        guard let t = await inbox.next() else { throw FakeError() }
        return t
    }

    func send(_ text: String) async throws { backend.received(text, from: device) }

    func close() { backend.disconnect(device: device, inbox) }
}

// MARK: - Cloud Distribution (in memory)

extension FakeBackend {
    private func cloudDevices(_ sessionId: String) -> [String] {
        lock.locked {
            guard let sess = sessions[sessionId] else { return [] }
            return [sess.senderDevice] + sess.members.filter { $0.participant.status == "JOINED" }.map(\.device)
        }
    }

    func cloudNotify(_ o: CloudObject) {
        guard let data = try? APIClient.encoder.encode(o), let obj = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
        for d in cloudDevices(o.sessionId) {
            push(to: d, ["type": .string("CLOUD_UPDATED"), "session_id": .string(o.sessionId), "object": obj])
        }
    }

    func cloudDistribute(fileId: String) throws -> CloudObject {
        let found: (String, Int64)? = lock.locked {
            for (sid, sess) in sessions {
                if let f = sess.files.first(where: { $0.id == fileId }) { return (sid, f.size) }
            }
            return nil
        }
        guard let (sid, size) = found
        else { throw APIError(status: 404, code: "not_found", message: "", retryAfterSeconds: nil, body: nil) }
        if let o = lock.locked({ cloudObjects.values.first { $0.fileId == fileId && $0.status != "DELETED" } }) { return o }
        let count = max(1, Int((size + Int64(cloudPartSize) - 1) / Int64(cloudPartSize)))
        let o = CloudObject(
            id: UUID().uuidString.lowercased(), sessionId: sid, fileId: fileId, status: "UPLOADING", paused: false, size: size,
            partSize: cloudPartSize, partCount: count, partsUploaded: 0, ciphertextSize: size + Int64(count * 28),
            createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-02T00:00:00Z"
        )
        lock.locked { cloudObjects[o.id] = o }
        return o
    }

    func cloudPut(_ id: String, _ n: Int, _ bytes: [UInt8]) throws -> CloudObject {
        try lock.locked {
            guard var o = cloudObjects[id], o.status == "UPLOADING", n >= 0, n < o.partCount else {
                throw APIError(status: 400, code: "invalid_part", message: "", retryAfterSeconds: nil, body: nil)
            }
            if cloudParts["\(id)/\(n)"] == nil { o.partsUploaded += 1 }
            cloudParts["\(id)/\(n)"] = bytes
            cloudObjects[id] = o
            return o
        }
    }

    func cloudSeal(_ id: String) throws -> CloudObject {
        let o: CloudObject = try lock.locked {
            guard var o = cloudObjects[id], o.partsUploaded == o.partCount else {
                throw APIError(status: 409, code: "parts_missing", message: "", retryAfterSeconds: nil, body: nil)
            }
            o.status = "READY"
            cloudObjects[id] = o
            return o
        }
        cloudNotify(o)
        return o
    }

    func cloudGet(_ id: String, _ n: Int) throws -> [UInt8] {
        guard let b = lock.locked({ cloudObjects[id]?.status == "READY" ? cloudParts["\(id)/\(n)"] : nil }) else {
            throw APIError(status: 409, code: "invalid_state", message: "", retryAfterSeconds: nil, body: nil)
        }
        return b
    }

    func cloudReceived(_ id: String) throws -> CloudObject {
        let o: CloudObject = try lock.locked {
            guard var o = cloudObjects[id] else { throw APIError(
                status: 404,
                code: "not_found",
                message: "",
                retryAfterSeconds: nil,
                body: nil
            ) }
            o.status = "DELETED"
            for n in 0 ..< o.partCount {
                cloudParts["\(id)/\(n)"] = nil
            }
            cloudObjects[id] = o
            return o
        }
        cloudNotify(o)
        return o
    }
}

extension FakeClient: CloudService {
    func cloudSettings() async throws -> CloudSettings {
        CloudSettings(
            available: true,
            signedIn: true,
            enabled: true,
            consented: true,
            budgetBytes: 1 << 30,
            usedBytes: 0,
            maxBudgetBytes: 1 << 40,
            ttlHours: 24
        )
    }

    func putCloudSettings(
        enabled _: Bool,
        consent _: Bool,
        budgetBytes _: Int64?
    ) async throws -> CloudSettings { try await cloudSettings() }

    func estimateCloud(bytes: Int64, receivers: Int) async throws -> CloudEstimate {
        CloudEstimate(
            storageBytes: bytes,
            egressBytes: bytes * Int64(receivers),
            retentionHours: 24,
            budgetBytes: 1 << 30,
            usedBytes: 0,
            withinBudget: true
        )
    }

    func distribute(fileId: String) async throws -> CloudObject { try backend.cloudDistribute(fileId: fileId) }
    func putPart(objectId: String, n: Int, bytes: [UInt8]) async throws -> CloudObject { try backend.cloudPut(objectId, n, bytes) }
    func seal(objectId: String) async throws -> CloudObject { try backend.cloudSeal(objectId) }

    func cloudObjects(sessionId: String) async throws -> [CloudObject] {
        backend.lock.locked { backend.cloudObjects.values.filter { $0.sessionId == sessionId && $0.status != "DELETED" } }
    }

    func getPart(objectId: String, n: Int) async throws -> [UInt8] { try backend.cloudGet(objectId, n) }
    func received(objectId: String) async throws -> CloudObject { try backend.cloudReceived(objectId) }
}
