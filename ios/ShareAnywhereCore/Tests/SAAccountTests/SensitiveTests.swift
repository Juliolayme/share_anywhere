@testable import SAAccount
import XCTest

/// The same cases as the Web's sensitive.test.ts and Android's SensitiveTest (docs/CLIPBOARD_PROTOCOL.md §2.7).
final class SensitiveTests: XCTestCase {
    private func kind(_ t: String) -> String? { Sensitive.kind(t)?.rawValue }

    func testOneTimeCodes() {
        for t in ["4829", "482913", " 48291375 ", "482 913", "4829-1375"] {
            XCTAssertEqual(kind(t), "otp", t)
        }
        for t in ["123", "123456789", "Code 482913 expires soon", "48 29"] {
            XCTAssertNotEqual(kind(t), "otp", t)
        }
    }

    func testJSONWebTokens() {
        // Assembled at runtime so secret scanners never see a token-shaped literal in the source.
        let jwt = [
            ["ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"].joined(),
            ["ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ"].joined(),
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        ].joined(separator: ".")
        XCTAssertEqual(kind(jwt), "jwt")
        XCTAssertEqual(kind("Authorization: Bearer \(jwt)"), "jwt")
    }

    func testPrivateKeyBlocks() {
        func begin(_ label: String) -> String { ["-----", "BEGIN ", label, "-----"].joined() }
        for label in ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"] {
            XCTAssertEqual(kind("notes\n\(begin(label))\nMIIEow...\n-----END \(label)-----"), "private_key")
        }
        XCTAssertEqual(kind("\(begin("PGP PRIVATE KEY BLOCK"))\nlQOYBF..."), "private_key")
        XCTAssertNil(kind("\(begin("CERTIFICATE"))\nMIIB...\n-----END CERTIFICATE-----"))
        XCTAssertNil(kind("\(begin("PUBLIC KEY"))\nMFkw..."))
    }

    func testAPIKeys() {
        XCTAssertEqual(kind(["AKIA", "IOSFODNN7EXAMPLE"].joined()), "api_key")
        XCTAssertEqual(kind("token \(["gh", "p_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"].joined()) here"), "api_key")
        XCTAssertEqual(kind(["sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"].joined()), "api_key")
    }

    func testHighEntropyTokens() {
        XCTAssertEqual(kind("Zx9qL2mN8vB4tR7wK1pS6dF3hJ5gY0cE"), "token")
        XCTAssertEqual(kind("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), "token")
        XCTAssertNil(kind("internationalization-and-localization"))
        XCTAssertNil(kind("https://example.com/a/very/long/path?query=Zx9qL2mN8vB4tR7wK1pS6dF3"))
        XCTAssertNil(kind("Order #A-5531 ships Thursday — tracking VN829104455. Pick up at Hub D7."))
        XCTAssertEqual(Sensitive.entropy("aaaa"), 0, accuracy: 1e-9)
        XCTAssertEqual(Sensitive.entropy("abcd"), 2, accuracy: 1e-9)
    }

    func testCardNumbers() {
        XCTAssertEqual(kind("4111 1111 1111 1111"), "card")
        XCTAssertEqual(kind("5500-0000-0000-0004"), "card")
        XCTAssertNil(kind("4111 1111 1111 1112"))
    }

    func testPasswordLikeWords() {
        XCTAssertEqual(kind("Tr0ub4dor&3"), "password")
        XCTAssertNil(kind("hello-world"))
        XCTAssertNil(kind("Meeting at 10:30!"))
    }

    func testOrdinaryText() {
        for t in [
            "Draft reply: Thanks — I’ll send the files tonight via Share Anywhere.", "Tiếng Việt có dấu, không phải bí mật.",
            "https://share-anywhere.example/j/abc", "Call me at 0901 234 567 tomorrow", "e2e clipboard marker 1731300000"
        ] {
            XCTAssertNil(kind(t), t)
        }
    }
}
