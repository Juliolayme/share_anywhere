# ADR 0022: iOS project layout, ShareAnywhereCore package, and toolchain

Status: Accepted (Phase 7, milestone 7.1, 2026-11-12)

## Context

Phase 7 builds the native iOS app (`docs/phases/PHASE_7_IOS.md`). `CLAUDE.md` §5 fixes SwiftUI, iOS 16 minimum, Xcode 16.x, Swift Package Manager only, an XcodeGen project (no committed `.pbxproj`), SwiftLint and SwiftFormat, and CryptoKit. `docs/TESTING_AND_CI.md` §5b requires the transfer engine, clipboard crypto and API client to live in an SPM package without UIKit whose tests run with `swift test` against the shared vector files. The development session runs on Linux without Xcode; only GitHub's macOS runners can build the app.

## Decision

- **`ios/ShareAnywhereCore` is a Swift 6 package (tools 6.0, Swift 6 language mode, strict concurrency).** Products are named as in the phase file: `Protocol`, `TransferEngine`, `ClipboardCrypto`, `APIClient`. Their module names carry an `SA` prefix (`SAProtocol`, `SATransferEngine`, `SAClipboardCrypto`, `SAAPIClient`) because a module named `Protocol` collides with the Objective-C runtime's `Protocol` type on Apple platforms.
- **The engine is a port of Android's Kotlin engine, not a new design.** Connections are actors. Each connection reads its channel through an ordered `AsyncStream` (frames are handled one at a time in arrival order, as SCTP delivers them); buffer-drain signals bypass that stream so a block pump waiting for `bufferedAmount` is never stuck behind queued frames; the receiver's block completion and control frames run on a second serial stream, as on Android.
- **Crypto through `swift-crypto` 3.10.0.** On Apple platforms it re-exports CryptoKit, so the app uses CryptoKit; on Linux it is BoringSSL-backed, which lets the same tests run in this environment and on the macOS runner. Argon2id comes from the vendored reference implementation (ADR 0024).
- **The package builds and tests on Linux too.** This session has Swift 6.0.3 for Linux; `swift test` runs every Core test (vectors, engine, crypto, client) before CI does. CI runs the same tests on `macos-15` with CryptoKit (`ci.yml` job `ios`).
- **Pinned tools, checksum-verified.** `scripts/ios-tools.sh` installs SwiftLint 0.57.1, SwiftFormat 0.55.3 and XcodeGen 2.42.0 from their GitHub releases and checks each SHA-256. Configs: `ios/.swiftlint.yml` (strict in CI), `ios/.swiftformat`. Generated (`API.gen.swift`) and vendored (`CArgon2`) code is excluded.
- **Dependencies are pinned exactly and `Package.resolved` is committed.**

## Alternatives considered

- **Hand-maintained `.xcodeproj` or a Tuist project.** `CLAUDE.md` §5 asks for XcodeGen; a committed `.pbxproj` is not reviewable.
- **CocoaPods or Carthage.** Ruled out by `CLAUDE.md` §5 (SPM only).
- **CryptoKit imported directly.** Ties the package to Apple platforms and loses Linux testing in the cloud session; `swift-crypto` is Apple's own API-compatible package and is CryptoKit on iOS.

## Consequences

- CryptoKit's Ed25519 signatures are randomized on Apple platforms. RFC 8032 verifiers accept them, and every peer verifies rather than compares signatures, so the vectors test verifies the deterministic vector signatures and this platform's own.
- A test that passes on Linux can still fail on Apple platforms (Foundation differences); CI on macOS is the gate.
