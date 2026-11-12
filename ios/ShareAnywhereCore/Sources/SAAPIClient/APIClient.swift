import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// An error response from the API (docs/API.md §3): HTTP status, machine-readable `error` code, wait hint.
public struct APIError: Error, Sendable, Equatable, CustomStringConvertible {
    public let status: Int
    public let code: String
    public let message: String
    public let retryAfterSeconds: Int?
    public let body: [String: JSONValue]?

    public var description: String { "\(status) \(code)" }
}

/// The backend could not be reached (offline, DNS, refused, timed out).
public struct NetworkError: Error, Sendable, CustomStringConvertible {
    public let underlying: String
    public var description: String { "network: \(underlying)" }
}

/// One HTTP exchange; `URLSessionTransport` in the app, a fake in tests.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw NetworkError(underlying: (error as NSError).domain + " \((error as NSError).code)")
        }
        guard let http = response as? HTTPURLResponse else { throw NetworkError(underlying: "not an HTTP response") }
        return (data, http)
    }
}

/// Thin JSON client for the operations in the generated `APIOperations` (docs/ADR/0023-ios-networking.md), the twin
/// of Android's `ApiClient`. It never logs requests, bodies or headers, so tokens and refresh secrets cannot reach a
/// log (docs/SECURITY_MODEL.md §8). Release builds refuse a cleartext base URL.
public struct APIClient: Sendable {
    public let baseURL: URL
    private let transport: any HTTPTransport
    private let userAgent: String

    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport(), requireHTTPS: Bool, userAgent: String) throws {
        if requireHTTPS,
           baseURL.scheme?
           .lowercased() !=
           "https" {
            throw APIError(
                status: 0,
                code: "insecure_base_url",
                message: "Release builds talk to the backend over HTTPS only",
                retryAfterSeconds: nil,
                body: nil
            )
        }
        self.baseURL = baseURL
        self.transport = transport
        self.userAgent = userAgent
    }

    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    public static let decoder = JSONDecoder()

    /// Sends `op` with an optional JSON `body` and bearer `token`, decoding the response as `Res`.
    public func call<Res: Decodable>(
        _ op: APIOperation, path: String? = nil, body: (some Encodable)? = String?.none, token: String? = nil,
        query: [String: String] = [:], headers: [String: String] = [:], as _: Res.Type = Res.self
    ) async throws -> Res {
        let data = try await send(
            op,
            path: path,
            body: body.map { try APIClient.encoder.encode($0) },
            token: token,
            query: query,
            headers: headers
        )
        do {
            return try APIClient.decoder.decode(Res.self, from: data.isEmpty ? Data("{}".utf8) : data)
        } catch {
            throw APIError(
                status: 0,
                code: "bad_response",
                message: "The server's answer could not be read.",
                retryAfterSeconds: nil,
                body: nil
            )
        }
    }

    /// Sends `op` and returns the raw response body (empty for 204).
    @discardableResult
    public func send(
        _ op: APIOperation, path: String? = nil, body: Data? = nil, token: String? = nil, query: [String: String] = [:],
        headers: [String: String] = [:]
    ) async throws -> Data {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let basePath = components.percentEncodedPath.hasSuffix("/") ? String(components.percentEncodedPath.dropLast()) : components
            .percentEncodedPath
        components.percentEncodedPath = basePath + (path ?? op.path)
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = components.url else { throw APIError(
            status: 0,
            code: "bad_request",
            message: "invalid URL",
            retryAfterSeconds: nil,
            body: nil
        ) }
        var req = URLRequest(url: url)
        req.httpMethod = op.method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (k, v) in headers {
            req.setValue(v, forHTTPHeaderField: k)
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if ["POST", "PUT", "PATCH"].contains(op.method) {
            req.httpBody = Data()
        }
        let (data, res) = try await transport.send(req)
        if (200 ..< 300).contains(res.statusCode) { return data }
        throw APIClient.apiError(res, data)
    }

    static func apiError(_ res: HTTPURLResponse, _ data: Data) -> APIError {
        let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data)
        var code = "http_\(res.statusCode)"
        var message = HTTPURLResponse.localizedString(forStatusCode: res.statusCode)
        var retry: Int?
        if case let .string(s)? = obj?["error"] { code = s }
        if case let .string(s)? = obj?["message"] { message = s }
        if case let .number(n)? = obj?["retry_after_s"] { retry = Int(n) }
        if retry == nil, let h = res.value(forHTTPHeaderField: "Retry-After"), let n = Int(h), n > 0 { retry = n }
        return APIError(status: res.statusCode, code: code, message: message, retryAfterSeconds: retry, body: obj)
    }
}
