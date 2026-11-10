# Phase 7 — iOS app

Read: PRD §2 (guest-first, device identity, signing in/out, history, iOS rows), §4, §5 (all), §5.10, §6.4; `docs/ARCHITECTURE.md` §2, §3, §4, §7; `docs/SECURITY_MODEL.md` §3, §4; `docs/API.md`; `docs/UX_SCREEN_MAP.md` (all, iOS column); §7.3b, §7.5; `docs/TESTING_AND_CI.md` §1, §2, §5b; `docs/TRANSFER_PROTOCOL.md`; `docs/CLIPBOARD_PROTOCOL.md`; `CLAUDE.md` §5 iOS pin.

Depends on Phase 5 (both milestones) only. May run in parallel with Phase 6 on a separate branch. This phase is verifiable only on the macOS runner (`ios` and `ios-simulator` jobs). If Xcode is not available locally (it never is in a Linux cloud session), still write the code so that `xcodegen generate` and `xcodebuild` succeed in CI, and let the workflow be the verification. Do not mark anything tested until the workflow is green.

## Scope

- `ios/project.yml` (XcodeGen) producing `ShareAnywhere.xcodeproj` with targets: `ShareAnywhere` (app), `ShareAnywhereTests`, `ShareAnywhereUITests`; local SPM package `ShareAnywhereCore` with products `Protocol`, `TransferEngine`, `ClipboardCrypto`, `APIClient`. iOS 16 minimum. SwiftLint and SwiftFormat configs. No signing material; `CODE_SIGNING_ALLOWED=NO` for CI.
- API client generated from `openapi.yaml` (`swift-openapi-generator`) and kept current by the `protocol` job; WebSocket client with `URLSessionWebSocketTask`, bearer device token, reconnect with backoff.
- Design tokens generated from `shared/design/tokens.json` into Swift (`Color`, `Font`, spacing) so iOS, Android, and Web share one source; if `tokens.json` does not exist yet (Phase 0 created CSS only), create it from the CSS variables and wire the Web build to consume it too.
- Guest-first start: Welcome once as a full-screen cover on first launch → Transfer tab; anonymous device identity created in the background; refresh secret in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, excluded from iCloud Keychain); access token in memory with silent refresh; 429 messaging.
- Local History in Core Data or GRDB (ADR; SwiftData is unavailable on iOS 16), with cloud sync merge when signed in.
- Devices (This device card for guests; account list when signed in), Settings (Guest header with Sign in; theme follows system plus override, EN/VI, notifications, privacy, account sections).
- Account screens presented as a sheet only from account CTAs: sign in, sign up, reset, post-sign-in choices, ADK setup or pairing / recovery phrase, sign-out with keep/clear local history and new anonymous identity.
- Send flow: `UIDocumentPickerViewController` multi-select with security-scoped access, review with the Require approval toggle (default off), create session, 10:00 join-window countdown with the "Code expired — Create new code" state and button and the "Session full" state, participant list with badges, security words, Remove and Block, join banner and a local notification when a receiver joins, request cards when approval is on, Stop accepting, QR/code/link display (QR via CoreImage `CIQRCodeGenerator`), share link via `ShareLink`, receiver capacity indicator.
- Receive flow: QR scan with `AVCaptureSession` + `VNDetectBarcodesRequest` (real device only; simulator shows code entry), code entry, Universal Link handling (`apple-app-site-association` served by Caddy; verified real-device only), preview, request, waiting, destination choice (app Documents visible in Files, or folder picked with document picker and persisted as a security-scoped bookmark), progress, verification, completed/failed/partial, "Open in Files".
- Transfer engine in `ShareAnywhereCore/TransferEngine` implementing the Phase 3 wire protocol with WebRTC (`stream-webrtc-ios` or Google `WebRTC` xcframework per ADR), streaming `FileHandle` I/O, CryptoKit `SHA256` streaming, bitmap persistence as a sidecar file next to the partial download, resume, backpressure via `bufferedAmount` observation, out-of-order handling. Shared test vectors with Web and Android.
- Keep screen on: `UIApplication.shared.isIdleTimerDisabled = true` while the keep-awake controller is active and the scene is `.active`; set back to `false` on completion, failure, pause, cancel, removal, session end, setting off, and on `.background`; re-applied on `.active`; status row with "Locking your iPhone pauses the transfer"; setting **Keep screen on during transfers** (default on).
- Lifecycle: `ScenePhase` observer pauses sending/receiving on `.background` after a `beginBackgroundTask` grace period, checkpoints the bitmap, schedules a local notification "Return to Share Anywhere to continue", and resumes on `.active`. No audio/VoIP/location background modes. `BGProcessingTask` only for clipboard sync and cleanup.
- Clipboard tab: account-required intro for guests (no `UIPasteboard` reads, no change observation, no `UIPasteControl` while a guest); "Add this device" for not-added devices; when ready, `UIPasteboard` observation while active, `UIPasteControl` primary sync, fallback button with banner explanation, `detectPatterns` pre-check for probable secrets, history/detail/Copy, pairing by scanning the Web QR (camera) or pasting the pairing code (simulator), Secure Enclave + Keychain wrapped ACK, recovery phrase entry, Home Screen quick action that opens the Clipboard tab.
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
- XCUITest (`ios-simulator`, iPhone 15): fresh install goes Welcome → Transfer with no sign-in screen; as a **guest**, create session and read code, join via code with open join (no approval step), let the join window expire (injected clock) and assert the expired state, Create new code, and that an already-joined receiver keeps transferring, Remove and Block, turn on Require approval and approve; `isIdleTimerDisabled` (exposed through the `-uiTesting` hook as the value of a hidden accessibility element) is `true` during waiting and transfer, `false` after completion, pause, cancel, and with the setting off, `false` after backgrounding and `true` again on return; local History entry survives relaunch; Clipboard tab shows the intro and the app performs no pasteboard access while a guest (asserted through the `-uiTesting` hook); then sign in against the native backend at `127.0.0.1:8080`, add the device, reach Clipboard history; sign-out yields a new device ID; seeded-document send to a Playwright receiver (interop job); receive into Documents and assert the file appears with the expected hash through the `-uiTesting` hook; clipboard foreground capture, background non-capture, `UIPasteControl` sync, fallback button; pairing by pasted code; background-suspend resume; screenshot attachments.
- Nightly: `ios-matrix`, `ios-web-interop` both directions, `ios-background-suspend`, `clipboard-cross-client` iOS half, `android-ios-interop` best-effort.

## CI changes

`ios`, `ios-simulator` jobs in `ci.yml` become required; `ios-simulator.yml` reusable workflow; nightly jobs above; `protocol` job regenerates the Swift client and fails on drift.

## Exit gate

Guest send and receive verified on the simulator without any sign-in. `ci.yml` green including simulator; both iOS ↔ Web directions green in nightly with run links; background-suspend resume test green; screenshots attached; every iOS limitation from PRD §2 and §7.3b reflected in UI copy; real-device checklist written and clearly marked untested.

## Report

Per `CLAUDE.md` §9. State the simulator device and runtime for every tested claim, and list camera QR, Universal Links, and real background timing as untested.
