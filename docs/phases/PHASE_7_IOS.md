# Phase 7 — iOS app

Read: PRD §2 (iOS rows), §4, §5 (all), §6.4, §7.3b, §7.5; `docs/TESTING_AND_CI.md` §1, §2, §5b; `docs/TRANSFER_PROTOCOL.md`; `docs/CLIPBOARD_PROTOCOL.md`; `CLAUDE.md` §5 iOS pin.

Depends on Phase 5 only. May run in parallel with Phase 6 on a separate branch. This phase is verifiable only on the macOS runner (`ios` and `ios-simulator` jobs). If Xcode is not available locally (it never is in a Linux cloud session), still write the code so that `xcodegen generate` and `xcodebuild` succeed in CI, and let the workflow be the verification. Do not mark anything tested until the workflow is green.

## Scope
- `ios/project.yml` (XcodeGen) producing `ShareAnywhere.xcodeproj` with targets: `ShareAnywhere` (app), `ShareAnywhereTests`, `ShareAnywhereUITests`; local SPM package `ShareAnywhereCore` with products `Protocol`, `TransferEngine`, `ClipboardCrypto`, `APIClient`. iOS 16 minimum. SwiftLint and SwiftFormat configs. No signing material; `CODE_SIGNING_ALLOWED=NO` for CI.
- API client generated from `openapi.yaml` (`swift-openapi-generator`) and kept current by the `protocol` job; WebSocket client with `URLSessionWebSocketTask`, bearer device token, reconnect with backoff.
- Design tokens generated from `shared/design/tokens.json` into Swift (`Color`, `Font`, spacing) so iOS, Android, and Web share one source; if `tokens.json` does not exist yet (Phase 0 created CSS only), create it from the CSS variables and wire the Web build to consume it too.
- Auth (sign up, sign in, reset), device registration, Devices, Settings (theme follows system plus override, EN/VI, notifications, clipboard, privacy), History.
- Send flow: `UIDocumentPickerViewController` multi-select with security-scoped access, review, create session, QR/code/link display (QR via CoreImage `CIQRCodeGenerator`), share link via `ShareLink`, approvals list with capacity indicator.
- Receive flow: QR scan with `AVCaptureSession` + `VNDetectBarcodesRequest` (real device only; simulator shows code entry), code entry, Universal Link handling (`apple-app-site-association` served by Caddy; verified real-device only), preview, request, waiting, destination choice (app Documents visible in Files, or folder picked with document picker and persisted as a security-scoped bookmark), progress, verification, completed/failed/partial, "Open in Files".
- Transfer engine in `ShareAnywhereCore/TransferEngine` implementing the Phase 3 wire protocol with WebRTC (`stream-webrtc-ios` or Google `WebRTC` xcframework per ADR), streaming `FileHandle` I/O, CryptoKit `SHA256` streaming, bitmap persistence as a sidecar file next to the partial download, resume, backpressure via `bufferedAmount` observation, out-of-order handling. Shared test vectors with Web and Android.
- Lifecycle: `ScenePhase` observer pauses sending/receiving on `.background` after a `beginBackgroundTask` grace period, checkpoints the bitmap, schedules a local notification "Return to Share Anywhere to continue", and resumes on `.active`. No audio/VoIP/location background modes. `BGProcessingTask` only for clipboard sync and cleanup.
- Clipboard: `UIPasteboard` observation while active, `UIPasteControl` primary sync, fallback button with banner explanation, `detectPatterns` pre-check for probable secrets, history/detail/Copy, pairing by scanning the Web QR (camera) or pasting the pairing code (simulator), Secure Enclave + Keychain wrapped ACK, recovery phrase entry, Home Screen quick action that opens the Clipboard tab.
- Accessibility: VoiceOver labels and traits, Dynamic Type through `accessibilityExtraExtraExtraLarge` without clipping on critical screens, 44 pt targets, reduced motion, `Localizable.xcstrings` EN/VI.
- Debug builds pin the CI self-signed Caddy certificate for the interop job; release builds do not include it.

## Out of scope
Route strategy beyond direct P2P with default ICE servers (Phase 8), Cloud Distribution (Phase 8), Share Extension, widgets beyond a deep-link quick action, keyboard extension, App Store submission, real-device testing.

## Deliverables
- `ios/` tree per `CLAUDE.md` §6; `docs/ADR/00xx-ios-webrtc-dependency.md`, `00xx-ios-storage-and-bookmarks.md`, `00xx-ios-background-policy.md`.
- `docs/runbooks/ios-real-device-checklist.md`: Universal Links, camera QR, background suspension timing, Files app integration, VoiceOver walkthrough, all marked "manual, untested in CI".
- Screenshots per screen (light/dark, Dynamic Type) attached to the report from CI artifacts.

## Tests to add
- `swift test` on `ShareAnywhereCore`: scheduler, bitmap, hasher, frame codec against shared vectors; clipboard crypto vectors; Keychain wrapper with an in-memory fake; API client decoding.
- XCUITest (`ios-simulator`, iPhone 15): sign in against the native backend at `127.0.0.1:8080`; create session and read code; join via code; seeded-document send to a Playwright receiver (interop job); receive into Documents and assert the file appears with the expected hash through the `-uiTesting` hook; clipboard foreground capture, background non-capture, `UIPasteControl` sync, fallback button; pairing by pasted code; background-suspend resume; screenshot attachments.
- Nightly: `ios-matrix`, `ios-web-interop` both directions, `ios-background-suspend`, `clipboard-cross-client` iOS half, `android-ios-interop` best-effort.

## CI changes
`ios`, `ios-simulator` jobs in `ci.yml` become required; `ios-simulator.yml` reusable workflow; nightly jobs above; `protocol` job regenerates the Swift client and fails on drift.

## Exit gate
`ci.yml` green including simulator; both iOS ↔ Web directions green in nightly with run links; background-suspend resume test green; screenshots attached; every iOS limitation from PRD §2 and §7.3b reflected in UI copy; real-device checklist written and clearly marked untested.

## Report
Per `CLAUDE.md` §9. State the simulator device and runtime for every tested claim, and list camera QR, Universal Links, and real background timing as untested.
