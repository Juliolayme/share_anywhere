import Foundation

/// Device identity endpoints (docs/API.md §2.1). Native clients use the `body` refresh transport.
public protocol DeviceEndpoints: Sendable {
    func create(_ request: CreateDeviceRequest) async throws -> DeviceSession
    func refresh(secret: String) async throws -> DeviceSession
    func current(token: String) async throws -> Device
    func rename(token: String, displayName: String) async throws -> Device
    /// New anonymous identity; the server revokes the old one.
    func reset(token: String) async throws -> DeviceSession
}

public struct DeviceAPI: DeviceEndpoints {
    private let client: APIClient
    public init(client: APIClient) { self.client = client }

    public func create(_ request: CreateDeviceRequest) async throws -> DeviceSession {
        try await client.call(APIOperations.createAnonymousDevice, body: request)
    }

    public func refresh(secret: String) async throws -> DeviceSession {
        try await client.call(APIOperations.refreshDeviceToken, body: RefreshRequest(refreshSecret: secret))
    }

    public func current(token: String) async throws -> Device {
        try await client.call(APIOperations.getCurrentDevice, token: token)
    }

    public func rename(token: String, displayName: String) async throws -> Device {
        try await client.call(APIOperations.updateCurrentDevice, body: UpdateDeviceRequest(displayName: displayName), token: token)
    }

    public func reset(token: String) async throws -> DeviceSession {
        try await client.call(APIOperations.resetCurrentDevice, token: token)
    }
}

public extension APIError {
    /// The challenge carried by a `428 pow_required` answer.
    var powChallenge: PowChallenge? {
        guard let body, let data = try? JSONEncoder().encode(body) else { return nil }
        return (try? JSONDecoder().decode(PowRequired.self, from: data))?.challenge
    }
}
