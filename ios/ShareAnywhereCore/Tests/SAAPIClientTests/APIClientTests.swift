import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif
@testable import SAAPIClient
import XCTest

final class FakeTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    let status: Int
    let body: String
    let headers: [String: String]

    init(status: Int, body: String, headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = headers
    }

    var requests: [URLRequest] { lock.withLock { _requests } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { _requests.append(request) }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
    }
}

/// The generated models and the thin client (docs/ADR/0023-ios-networking.md).
final class APIClientTests: XCTestCase {
    func testEveryOperationHasMethodPathAndAccess() {
        XCTAssertFalse(APIOperations.all.isEmpty)
        let levels: Set = ["public", "device", "participant", "account", "account+device"]
        for op in APIOperations.all {
            XCTAssertTrue(["GET", "POST", "PUT", "PATCH", "DELETE"].contains(op.method), op.path)
            XCTAssertTrue(op.path.hasPrefix("/"), op.path)
            XCTAssertTrue(levels.contains(op.access), "\(op.path) \(op.access)")
        }
        XCTAssertEqual(APIOperations.getHealth.access, "public")
    }

    func testPathPlaceholdersArePercentEncoded() {
        let op = APIOperation(method: "GET", path: "/v1/sessions/{id}/files/{file}", access: "participant")
        XCTAssertEqual(op.path("a b", "x/y"), "/v1/sessions/a%20b/files/x%2Fy")
    }

    func testRequestCarriesTheBearerTokenAndDecodesTheResponse() async throws {
        let t = FakeTransport(status: 200, body: #"{"status":"ok","version":"1.2.3"}"#)
        let client = try APIClient(
            baseURL: URL(string: "http://127.0.0.1:8080")!,
            transport: t,
            requireHTTPS: false,
            userAgent: "ShareAnywhere-iOS/test"
        )
        let health: Health = try await client.call(APIOperations.getHealth, token: "tok")
        XCTAssertEqual(health.status, "ok")
        let r = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(r.url?.absoluteString, "http://127.0.0.1:8080/healthz")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(r.value(forHTTPHeaderField: "User-Agent"), "ShareAnywhere-iOS/test")
    }

    func testErrorsCarryTheCodeAndTheWaitHint() async throws {
        let t = FakeTransport(status: 429, body: #"{"error":"rate_limited","message":"Slow down","retry_after_s":12}"#)
        let client = try APIClient(baseURL: URL(string: "http://127.0.0.1:8080")!, transport: t, requireHTTPS: false, userAgent: "t")
        do {
            _ = try await client.send(APIOperations.getHealth)
            XCTFail("expected an error")
        } catch let e as APIError {
            XCTAssertEqual(e.status, 429)
            XCTAssertEqual(e.code, "rate_limited")
            XCTAssertEqual(e.retryAfterSeconds, 12)
        }
        let h = FakeTransport(status: 503, body: "", headers: ["Retry-After": "5"])
        let c2 = try APIClient(baseURL: URL(string: "http://127.0.0.1:8080")!, transport: h, requireHTTPS: false, userAgent: "t")
        do {
            _ = try await c2.send(APIOperations.getHealth)
            XCTFail("expected an error")
        } catch let e as APIError {
            XCTAssertEqual(e.code, "http_503")
            XCTAssertEqual(e.retryAfterSeconds, 5)
        }
    }

    func testReleaseBuildsRefuseCleartext() {
        XCTAssertThrowsError(try APIClient(baseURL: URL(string: "http://example.test")!, requireHTTPS: true, userAgent: "t"))
        XCTAssertNoThrow(try APIClient(baseURL: URL(string: "https://example.test")!, requireHTTPS: true, userAgent: "t"))
    }

    func testModelsDecodeServerJSONAndIgnoreUnknownFields() throws {
        let json = #"{"status":"ok","version":"1","extra_field":1}"#
        XCTAssertEqual(try JSONDecoder().decode(Health.self, from: Data(json.utf8)).status, "ok")
        let v = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"a":[1,true,null,"x"]}"#.utf8))
        XCTAssertEqual(v, .object(["a": .array([.number(1), .bool(true), .null, .string("x")])]))
    }
}
