import Foundation
@_exported import SAAPIClient
@_exported import SATransferEngine

/// The data channel label of protocol version 1 (docs/TRANSFER_PROTOCOL.md §1).
public let transferChannelLabel = "sa-transfer/1"

/// Signaling payloads: the same JSON as the Web's RTCSessionDescriptionInit / RTCIceCandidateInit, wrapped with the
/// connection id (`conn`) that pairs an offer with its answer and candidates.
public struct SDPJSON: Codable, Sendable, Equatable {
    public var type: String
    public var sdp: String
    public init(type: String, sdp: String) {
        self.type = type
        self.sdp = sdp
    }
}

public struct CandidateJSON: Codable, Sendable, Equatable {
    public var candidate: String
    public var sdpMid: String?
    public var sdpMLineIndex: Int?
    public var usernameFragment: String?

    public init(candidate: String, sdpMid: String? = nil, sdpMLineIndex: Int? = nil, usernameFragment: String? = nil) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
        self.usernameFragment = usernameFragment
    }

    /// Keeps only the known fields with length checks (nil when unusable): candidates come from the other peer.
    public func sanitized() -> CandidateJSON? {
        if candidate.isEmpty || candidate.count > 1024 { return nil }
        return CandidateJSON(
            candidate: candidate,
            sdpMid: sdpMid.flatMap { $0.count <= 64 ? $0 : nil },
            sdpMLineIndex: sdpMLineIndex,
            usernameFragment: usernameFragment.flatMap { $0.count <= 256 ? $0 : nil }
        )
    }
}

public struct SDPPayload: Codable, Sendable, Equatable {
    public var conn: String
    public var sdp: SDPJSON
    public init(conn: String, sdp: SDPJSON) {
        self.conn = conn
        self.sdp = sdp
    }
}

public struct CandidatePayload: Codable, Sendable, Equatable {
    public var conn: String
    public var candidate: CandidateJSON?
    public init(conn: String, candidate: CandidateJSON?) {
        self.conn = conn
        self.candidate = candidate
    }
}

/// One server message (shared/protocol/websocket-events.json), or a synthetic SOCKET_OPEN / SOCKET_CLOSED.
public struct SocketEvent: Sendable, Equatable {
    public static let open = "SOCKET_OPEN"
    public static let closed = "SOCKET_CLOSED"

    public let type: String
    public let body: [String: JSONValue]

    public init(type: String, body: [String: JSONValue] = [:]) {
        self.type = type
        self.body = body
    }

    public func string(_ key: String) -> String? {
        if case let .string(s)? = body[key] { return s }
        return nil
    }

    public var sessionId: String? { string("session_id") }
    public var from: String? { string("from") }

    /// Decodes one member (an object such as `payload`, `participant` or `transfer`) as `T`.
    public func decode<T: Decodable>(_ key: String, as _: T.Type = T.self) -> T? {
        guard let v = body[key], let data = try? JSONEncoder().encode(v) else { return nil }
        return try? APIClient.decoder.decode(T.self, from: data)
    }
}

/// Builds a client signaling message (OFFER, ANSWER, ICE_CANDIDATE) for `SessionSocket.send`.
public func signalMessage(type: String, sessionId: String, to: String, payload: some Encodable) -> [String: JSONValue]? {
    guard let data = try? APIClient.encoder.encode(payload), let value = try? JSONDecoder().decode(JSONValue.self, from: data) else {
        return nil
    }
    return ["type": .string(type), "session_id": .string(sessionId), "to": .string(to), "payload": value]
}
