import Foundation

/// Claims of a device access token read for display state only (docs/ADR/0008-device-token-format.md): the server
/// verifies the EdDSA signature and decides access on every request, so nothing here is trusted.
public struct TokenClaims: Sendable, Equatable {
    /// Device ID.
    public let sub: String?
    /// Account ID while this device has an account session.
    public let acct: String?
    /// True when the device is added to that account.
    public let dl: Bool
    /// Expiry in epoch seconds.
    public let exp: Int64?

    /// Decodes the payload of a JWT without verifying it; nil for anything that is not a JWT.
    public static func decode(_ token: String) -> TokenClaims? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, !parts[1].isEmpty else { return nil }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 = b64.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        while b64.count % 4 != 0 {
            b64 += "="
        }
        guard let data = Data(base64Encoded: b64),
              let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data) else { return nil }
        func string(_ k: String) -> String? { if case let .string(s)? = obj[k] { s } else { nil } }
        var exp: Int64?
        if case let .number(n)? = obj["exp"] { exp = Int64(n) }
        var dl = false
        if case let .bool(b)? = obj["dl"] { dl = b }
        return TokenClaims(sub: string("sub"), acct: string("acct").flatMap { $0.isEmpty ? nil : $0 }, dl: dl, exp: exp)
    }
}
