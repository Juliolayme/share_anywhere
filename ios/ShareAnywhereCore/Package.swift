// swift-tools-version:6.0
// ShareAnywhereCore: the platform-independent part of the iOS app (CLAUDE.md §6, docs/TESTING_AND_CI.md §5b).
// No UIKit: it builds and tests with `swift test` on macOS and on Linux, against the same vector files as the Web
// and Android (shared/protocol/schemas/*.json). Products are named as in docs/phases/PHASE_7_IOS.md; module names
// carry an `SA` prefix because `Protocol` is already a type name in the Objective-C runtime (docs/ADR/0022).
import PackageDescription

let package = Package(
    name: "ShareAnywhereCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "Protocol", targets: ["SAProtocol"]),
        .library(name: "TransferEngine", targets: ["SATransferEngine"]),
        .library(name: "ClipboardCrypto", targets: ["SAClipboardCrypto"]),
        .library(name: "APIClient", targets: ["SAAPIClient"]),
        .library(name: "Store", targets: ["SAStore"]),
        .library(name: "TransferRuntime", targets: ["SATransferRuntime"])
    ],
    dependencies: [
        // CryptoKit on Apple platforms (swift-crypto re-exports it there), BoringSSL-backed elsewhere.
        .package(url: "https://github.com/apple/swift-crypto.git", exact: "3.10.0")
    ],
    targets: [
        .target(
            name: "CArgon2",
            path: "Sources/CArgon2",
            exclude: ["LICENSE", "VENDORED.md"],
            cSettings: [.define("ARGON2_NO_THREADS")]
        ),
        .target(
            name: "SAProtocol",
            dependencies: [.product(name: "Crypto", package: "swift-crypto")]
        ),
        .target(
            name: "SATransferEngine",
            dependencies: ["SAProtocol"]
        ),
        .target(
            name: "SAClipboardCrypto",
            dependencies: ["CArgon2", .product(name: "Crypto", package: "swift-crypto")],
            resources: [.copy("Resources/bip39-english.txt")]
        ),
        .target(name: "SAAPIClient", dependencies: [.product(name: "Crypto", package: "swift-crypto")]),
        .systemLibrary(name: "CSQLite", path: "Sources/CSQLite", providers: [.apt(["libsqlite3-dev"])]),
        // Apple platforms use the SDK's SQLite3 module; Linux (tests in the cloud session) the system library.
        .target(name: "SAStore", dependencies: [.target(name: "CSQLite", condition: .when(platforms: [.linux]))]),
        // Sessions, signaling, peer links, storage and the sender / receiver controllers, behind protocols so the
        // whole receive and send logic runs in `swift test` with in-memory peers (the app plugs in StreamWebRTC).
        .target(
            name: "SATransferRuntime",
            dependencies: ["SATransferEngine", "SAAPIClient", "SAStore", .product(name: "Crypto", package: "swift-crypto")]
        ),
        .testTarget(name: "SAProtocolTests", dependencies: ["SAProtocol"]),
        .testTarget(name: "SATransferEngineTests", dependencies: ["SATransferEngine"]),
        .testTarget(name: "SAClipboardCryptoTests", dependencies: ["SAClipboardCrypto"]),
        .testTarget(name: "SAAPIClientTests", dependencies: ["SAAPIClient"]),
        .testTarget(name: "SAStoreTests", dependencies: ["SAStore"]),
        .testTarget(name: "SATransferRuntimeTests", dependencies: ["SATransferRuntime"])
    ],
    swiftLanguageModes: [.v6]
)
