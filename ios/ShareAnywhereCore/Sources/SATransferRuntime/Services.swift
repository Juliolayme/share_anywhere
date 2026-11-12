import Foundation

/// A participant decision (docs/API.md §2.2). `leave` is the receiver's own; the others are the sender's.
public enum Decision: Sendable {
    case approve, reject, block, leave

    var operation: APIOperation {
        switch self {
        case .approve: APIOperations.approveParticipant
        case .reject: APIOperations.rejectParticipant
        case .block: APIOperations.blockParticipant
        case .leave: APIOperations.leaveSession
        }
    }
}

public enum TransferActionKind: Sendable {
    case pause, resume, cancel

    var operation: APIOperation {
        switch self {
        case .pause: APIOperations.pauseTransfer
        case .resume: APIOperations.resumeTransfer
        case .cancel: APIOperations.cancelTransfer
        }
    }
}

/// Share-session calls (docs/API.md §2.2). Guests and signed-in devices use the same calls with the device access
/// token (PRD §2: file sharing never needs an account).
public protocol SessionService: Sendable {
    func create(files: [FileInput], requireApproval: Bool) async throws -> SessionView
    func listOpen() async throws -> OpenSessionList
    func get(_ id: String) async throws -> SessionView
    func update(_ id: String, _ body: UpdateSessionRequest) async throws -> SessionView
    func renew(_ id: String) async throws -> SessionView
    func close(_ id: String) async throws
    func resolveCode(_ code: String) async throws -> JoinPreview
    func resolveLink(_ token: String) async throws -> JoinPreview
    func join(sessionId: String, ticket: String) async throws -> JoinResult
    func decide(participantId: String, _ decision: Decision) async throws -> Participant
    func remove(participantId: String) async throws -> Participant
    func wsTicket() async throws -> WsTicket
}

/// Transfer records, reports, actions and TURN credentials (docs/API.md §2.3).
public protocol TransferService: Sendable {
    func list(sessionId: String) async throws -> TransferList
    /// Receiver only (the server refuses senders with 403 receiver_only).
    func report(transferId: String, status: String, verifiedBytes: Int64, route: String?) async throws -> Transfer
    /// pause, resume or cancel; a receiver presents its transfer capability.
    func action(transferId: String, _ kind: TransferActionKind, capability: String?) async throws -> Transfer
    func turn(sessionId: String) async throws -> TurnCredentials
}

private struct CodeRequest: Encodable { let code: String }
private struct LinkRequest: Encodable { let token: String }
private struct TicketRequest: Encodable { let ticket: String }
private struct TurnRequest: Encodable {
    let sessionId: String
    enum CodingKeys: String, CodingKey { case sessionId = "session_id" }
}

/// Path segments are URL-encoded even though the server sends UUIDs (ids can come from links).
func segment(_ v: String) -> String {
    v.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? v
}

func path(_ op: APIOperation, _ name: String, _ value: String) -> String {
    op.path.replacingOccurrences(of: "{\(name)}", with: segment(value))
}

/// The live services over `APIClient` and the device identity.
public struct LiveServices: SessionService, TransferService {
    private let client: APIClient
    private let identity: IdentityManager

    public init(client: APIClient, identity: IdentityManager) {
        self.client = client
        self.identity = identity
    }

    private func call<Res: Decodable & Sendable>(
        _ op: APIOperation, path: String? = nil, body: (some Encodable & Sendable)? = String?.none, as _: Res.Type = Res.self
    ) async throws -> Res {
        let client = client
        return try await identity.authorized { token in
            try await client.call(op, path: path, body: body, token: token, as: Res.self)
        }
    }

    private struct Empty: Decodable, Sendable {}

    public func create(files: [FileInput], requireApproval: Bool) async throws -> SessionView {
        try await call(APIOperations.createSession, body: CreateSessionRequest(files: files, requireApproval: requireApproval))
    }

    public func listOpen() async throws -> OpenSessionList { try await call(APIOperations.listOpenSessions) }

    public func get(_ id: String) async throws -> SessionView {
        try await call(APIOperations.getSession, path: path(APIOperations.getSession, "id", id))
    }

    public func update(_ id: String, _ body: UpdateSessionRequest) async throws -> SessionView {
        try await call(APIOperations.updateSession, path: path(APIOperations.updateSession, "id", id), body: body)
    }

    public func renew(_ id: String) async throws -> SessionView {
        try await call(APIOperations.renewSession, path: path(APIOperations.renewSession, "id", id))
    }

    public func close(_ id: String) async throws {
        let _: Empty = try await call(APIOperations.closeSession, path: path(APIOperations.closeSession, "id", id))
    }

    public func resolveCode(_ code: String) async throws -> JoinPreview {
        try await call(APIOperations.resolveCode, body: CodeRequest(code: code))
    }

    public func resolveLink(_ token: String) async throws -> JoinPreview {
        try await call(APIOperations.resolveLink, body: LinkRequest(token: token))
    }

    public func join(sessionId: String, ticket: String) async throws -> JoinResult {
        try await call(
            APIOperations.joinSession,
            path: path(APIOperations.joinSession, "id", sessionId),
            body: TicketRequest(ticket: ticket)
        )
    }

    public func decide(participantId: String, _ decision: Decision) async throws -> Participant {
        try await call(decision.operation, path: path(decision.operation, "id", participantId))
    }

    public func remove(participantId: String) async throws -> Participant {
        try await call(APIOperations.removeParticipant, path: path(APIOperations.removeParticipant, "id", participantId))
    }

    public func wsTicket() async throws -> WsTicket { try await call(APIOperations.createWsTicket) }

    public func list(sessionId: String) async throws -> TransferList {
        try await call(APIOperations.listTransfers, path: path(APIOperations.listTransfers, "id", sessionId))
    }

    public func report(transferId: String, status: String, verifiedBytes: Int64, route: String?) async throws -> Transfer {
        try await call(
            APIOperations.reportTransfer,
            path: path(APIOperations.reportTransfer, "id", transferId),
            body: TransferReport(status: status, verifiedBytes: verifiedBytes, route: route)
        )
    }

    public func action(transferId: String, _ kind: TransferActionKind, capability: String?) async throws -> Transfer {
        try await call(kind.operation, path: path(kind.operation, "id", transferId), body: TransferAction(capability: capability))
    }

    public func turn(sessionId: String) async throws -> TurnCredentials {
        try await call(APIOperations.createTurnCredentials, body: TurnRequest(sessionId: sessionId))
    }
}
