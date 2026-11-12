import Foundation

/// Account, key, pairing, history-sync and clipboard calls (docs/API.md §2.4–§2.6), the Swift twin of Android's
/// `AccountApi` and `ClipboardApi`. Every call carries the device access token; account calls work only once the token
/// has the `acct` claim, and key, history and clipboard calls need an added device (`account+device`).
public protocol AccountEndpoints: Sendable {
    func signUp(email: String, password: String, addDevice: Bool) async throws -> AuthResult
    func signIn(email: String, password: String, addDevice: Bool) async throws -> AuthResult
    func signOut() async throws -> DeviceSession
    func requestReset(email: String) async throws
    func me() async throws -> Me
    func setHistorySync(_ on: Bool) async throws -> Me
    func addCurrent(copyHistory: Bool) async throws -> AccountToken
    func devices() async throws -> [AccountDevice]
    func renameDevice(_ id: String, name: String) async throws -> AccountDevice
    func revokeDevice(_ id: String) async throws
    func keys() async throws -> KeysState
    func registerKey(_ req: DeviceKeyRequest) async throws
    func setupKeys(_ req: KeysSetupRequest) async throws -> KeyVersion
    func recovery() async throws -> RecoveryBlob
    func rotate(_ req: KeysRotateRequest) async throws -> KeyVersion
    func chain() async throws -> KeyChain
    func ackPending(_ keyVersion: Int) async throws
    func createPairing(ephemeralPublicKey: String) async throws -> Pairing
    func pairingStatus(_ id: String) async throws -> PairingStatus
    func lookupPairing(_ code: String) async throws -> PairingPeer
    func wrapPairing(_ code: String, _ req: PairingWrapRequest) async throws
}

public protocol HistoryEndpoints: Sendable {
    func historyEntries(after: Int64, limit: Int) async throws -> HistoryPage
    func addHistoryEntry(_ req: HistoryEntryRequest) async throws -> Int64
    func deleteHistoryEntry(_ id: String) async throws
    func clearHistory() async throws
}

public protocol ClipboardEndpoints: Sendable {
    func history(limit: Int) async throws -> ClipboardHistory
    func events(cursor: Int64, limit: Int) async throws -> ClipboardEventPage
    func create(_ req: ClipboardEventRequest) async throws -> ClipboardEventCreated
    func remove(_ eventID: String) async throws
    func clear() async throws
    func settings() async throws -> ClipboardSettings
    func saveSettings(_ s: ClipboardSettings) async throws -> ClipboardSettings
}

private struct EmailRequest: Encodable, Sendable { let email: String }
private struct HistorySyncRequest: Encodable, Sendable {
    let historySync: Bool
    enum CodingKeys: String, CodingKey { case historySync = "history_sync" }
}

private struct AddCurrent: Encodable, Sendable {
    let copyHistory: Bool
    enum CodingKeys: String, CodingKey { case copyHistory = "copy_history" }
}

private struct RenameRequest: Encodable, Sendable { let name: String }
private struct EphemeralKey: Encodable, Sendable {
    let ephemeralPublicKey: String
    enum CodingKeys: String, CodingKey { case ephemeralPublicKey = "ephemeral_public_key" }
}

private struct DeviceList: Decodable, Sendable { let devices: [AccountDevice] }
private struct SeqResponse: Decodable, Sendable { let seq: Int64 }
private struct Empty: Decodable, Sendable {}

private func seg(_ v: String) -> String {
    v.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? v
}

private func path(_ op: APIOperation, _ name: String, _ value: String) -> String {
    op.path.replacingOccurrences(of: "{\(name)}", with: seg(value))
}

/// The live endpoints over `APIClient` and the device identity.
public struct LiveAccountAPI: AccountEndpoints, HistoryEndpoints, ClipboardEndpoints {
    private let client: APIClient
    private let identity: IdentityManager

    public init(client: APIClient, identity: IdentityManager) {
        self.client = client
        self.identity = identity
    }

    private func call<Res: Decodable & Sendable>(
        _ op: APIOperation, path: String? = nil, body: (some Encodable & Sendable)? = String?.none, query: [String: String] = [:],
        as _: Res.Type = Res.self
    ) async throws -> Res {
        let client = client
        return try await identity.authorized { token in
            try await client.call(op, path: path, body: body, token: token, query: query, as: Res.self)
        }
    }

    public func signUp(email: String, password: String, addDevice: Bool) async throws -> AuthResult {
        try await call(
            APIOperations.signUp,
            body: CredentialsRequest(email: email, password: password, addDevice: addDevice, copyHistory: false)
        )
    }

    public func signIn(email: String, password: String, addDevice: Bool) async throws -> AuthResult {
        try await call(
            APIOperations.signIn,
            body: CredentialsRequest(email: email, password: password, addDevice: addDevice, copyHistory: false)
        )
    }

    public func signOut() async throws -> DeviceSession { try await call(APIOperations.signOut) }

    public func requestReset(email: String) async throws {
        try await client.send(APIOperations.requestPasswordReset, body: APIClient.encoder.encode(EmailRequest(email: email)))
    }

    public func me() async throws -> Me { try await call(APIOperations.getMe) }

    public func setHistorySync(_ on: Bool) async throws -> Me { try await call(
        APIOperations.updateMe,
        body: HistorySyncRequest(historySync: on)
    ) }

    public func addCurrent(copyHistory: Bool) async throws -> AccountToken {
        try await call(APIOperations.addCurrentDevice, body: AddCurrent(copyHistory: copyHistory))
    }

    public func devices() async throws -> [AccountDevice] { try await call(APIOperations.listAccountDevices, as: DeviceList.self).devices }

    public func renameDevice(_ id: String, name: String) async throws -> AccountDevice {
        try await call(
            APIOperations.renameAccountDevice,
            path: path(APIOperations.renameAccountDevice, "id", id),
            body: RenameRequest(name: name)
        )
    }

    public func revokeDevice(_ id: String) async throws {
        let _: Empty = try await call(APIOperations.revokeAccountDevice, path: path(APIOperations.revokeAccountDevice, "id", id))
    }

    public func keys() async throws -> KeysState { try await call(APIOperations.getKeys) }

    public func registerKey(_ req: DeviceKeyRequest) async throws {
        let _: Empty = try await call(APIOperations.registerDeviceKey, body: req)
    }

    public func setupKeys(_ req: KeysSetupRequest) async throws -> KeyVersion { try await call(APIOperations.setupKeys, body: req) }

    public func recovery() async throws -> RecoveryBlob { try await call(APIOperations.getRecoveryBlob) }

    public func rotate(_ req: KeysRotateRequest) async throws -> KeyVersion { try await call(APIOperations.rotateKeys, body: req) }

    public func chain() async throws -> KeyChain { try await call(APIOperations.getKeyChain) }

    public func ackPending(_ keyVersion: Int) async throws {
        let _: Empty = try await call(
            APIOperations.ackPendingKey,
            path: path(APIOperations.ackPendingKey, "key_version", String(keyVersion))
        )
    }

    public func createPairing(ephemeralPublicKey: String) async throws -> Pairing {
        try await call(APIOperations.createPairing, body: EphemeralKey(ephemeralPublicKey: ephemeralPublicKey))
    }

    public func pairingStatus(_ id: String) async throws -> PairingStatus {
        try await call(APIOperations.getPairingResult, path: path(APIOperations.getPairingResult, "pairing_id", id))
    }

    public func lookupPairing(_ code: String) async throws -> PairingPeer {
        try await call(APIOperations.lookupPairing, path: path(APIOperations.lookupPairing, "code", code))
    }

    public func wrapPairing(_ code: String, _ req: PairingWrapRequest) async throws {
        let _: Empty = try await call(APIOperations.wrapPairing, path: path(APIOperations.wrapPairing, "code", code), body: req)
    }

    public func historyEntries(after: Int64, limit: Int) async throws -> HistoryPage {
        try await call(APIOperations.listHistoryEntries, query: ["after": String(after), "limit": String(limit)])
    }

    public func addHistoryEntry(_ req: HistoryEntryRequest) async throws -> Int64 {
        try await call(APIOperations.createHistoryEntry, body: req, as: SeqResponse.self).seq
    }

    public func deleteHistoryEntry(_ id: String) async throws {
        let _: Empty = try await call(APIOperations.deleteHistoryEntry, path: path(APIOperations.deleteHistoryEntry, "entry_id", id))
    }

    public func clearHistory() async throws { let _: Empty = try await call(APIOperations.clearHistory) }

    public func history(limit: Int) async throws -> ClipboardHistory {
        try await call(APIOperations.getClipboardHistory, query: ["limit": String(limit)])
    }

    public func events(cursor: Int64, limit: Int) async throws -> ClipboardEventPage {
        try await call(APIOperations.listClipboardEvents, query: ["cursor": String(cursor), "limit": String(limit)])
    }

    public func create(_ req: ClipboardEventRequest) async throws -> ClipboardEventCreated {
        try await call(APIOperations.createClipboardEvent, body: req)
    }

    public func remove(_ eventID: String) async throws {
        let _: Empty = try await call(
            APIOperations.deleteClipboardEvent,
            path: path(APIOperations.deleteClipboardEvent, "event_id", eventID)
        )
    }

    public func clear() async throws { let _: Empty = try await call(APIOperations.clearClipboardHistory) }

    public func settings() async throws -> ClipboardSettings { try await call(APIOperations.getClipboardSettings) }

    public func saveSettings(_ s: ClipboardSettings) async throws -> ClipboardSettings { try await call(
        APIOperations.putClipboardSettings,
        body: s
    ) }
}
