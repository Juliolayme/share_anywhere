# Phase 7 report: iOS app

Status: in progress (QA pending). File sharing is guest-first on iOS: Welcome leads to Transfer, send and receive never ask for an account, and the account sheet opens only from account entry points (Settings Sign in, Clipboard, Devices).

Every "tested" claim below was executed in GitHub Actions on the macOS 15 runner (Xcode 16.4, iOS 18.5 simulator SDK) against the Go backend run natively (`testhooks` build, Homebrew PostgreSQL 16). The simulator device is named per run; the runner image offers only iOS 18.x runtimes for Xcode 16.4, so the nightly "oldest runtime" entry also ran on iOS 18.5.

## 1. What was implemented

**Implemented and tested**

- **Core package (7.1).** `ios/ShareAnywhereCore` (SwiftPM, Swift 6 language mode, iOS 16 / macOS 13): wire protocol and frames byte for byte with the Web and Android (`shared/protocol/schemas/transfer-vectors.json`), the transfer engine (scheduler, bitmap, block cache, streaming SHA-256), account-key crypto with the shared vectors (CryptoKit through swift-crypto, vendored Argon2id; ADR 0024), the generated API models and client, device identity with the refresh secret in the Keychain, and SQLite History (ADR 0025). `swift test` runs on Linux in the cloud session and on macOS in the `ios` CI job.
- **App shell (7.2).** XcodeGen project (ADR 0022), design tokens and the EN/VI String Catalog generated from `shared/`, Welcome once, Transfer home, History with filters and detail, Devices (This device), Settings, pinned SwiftLint/SwiftFormat/XcodeGen, the `ios-simulator` reusable workflow.
- **Send and receive (7.3).** `SATransferRuntime` in the core package: sessions, the WebSocket (`URLSessionWebSocketTask`, one-time ticket, ordered outbox, backoff), the sender and receiver controllers ported from Android (offer/answer per receiver, capability check, reports through the transfer state machine, 2/10-minute reconnect windows, History), hidden partial files with sidecar bitmaps and resume. StreamWebRTC 145.25.0 behind a `PeerLink` protocol (ADR 0026). Screens: Send (document picker in place, 20 GB limit, Require approval off by default, open-session cap), Session (QR, code, link, 10:00 countdown on the server clock, Code expired with Create new code, Session full, capacity, Stop accepting, participants with security words, Approve/Reject, Remove/Block, per-receiver progress and result), Receive (code entry; camera scanning on devices), Join preview, waiting for approval, where to save (Documents or a picked folder), progress, result with Open in Files. Keep screen on (`isIdleTimerDisabled`, keep-open banner, screen-on pill, "Locking your iPhone pauses the transfer") and the background policy (grace period, pause, `ios.susp_h`, resume; ADR 0027). Share links open the join preview (Universal Links on devices, `shareanywhere://j/<token>` in tests).
- **Accounts and Clipboard (7.4).** `SAAccount` in the core package ported from Android: key flows with the authenticity checks of `docs/CLIPBOARD_PROTOCOL.md` §1.13, account keys with a sealed vault (Secure Enclave-derived key on hardware, Keychain key on the simulator), the account manager (wipe when the account session ends, key checks, history sync, revoke then rotate), encrypted history sync, and the Clipboard Sync engine with its encrypted cache, offline queue and sensitive heuristics. App: the account sheet (sign in, create account, reset, add this device, key setup, pairing or recovery phrase, checklist), Settings account rows and sign-out, account devices with rename, revoke and Pair a new device, the Clipboard tab (guest intro with no pasteboard access, Paste control, fallback read, hints, banners, timeline, detail, clear), the Home Screen quick action. Flags `accounts` and `clipboard` on.

**Implemented but untested on a real device** (`docs/runbooks/ios-real-device-checklist.md`, all marked manual)

- Camera QR scanning (AVFoundation + Vision): simulators have no camera.
- Universal Links: need a signed build with the associated domain and `SA_APPLE_APP_ID` on Caddy.
- Real background suspension timing, Low Power Mode, screen lock behaviour.
- The Secure Enclave path of the key vault (simulators have no Enclave).
- Files app integration with iCloud Drive and external providers, storage full on a device, VoiceOver walkthrough.

**Partially implemented / planned**

- Route strategy beyond direct P2P with the TURN credentials (Phase 8), Cloud Distribution (Phase 8).
- Change password and two-step verification are not on iOS (`docs/design/DESIGN_DEVIATIONS.md` section N).
- `android-ios-interop` (best effort in the phase file) is not built.

## 2. Usable screens and routes (iOS)

Welcome, Transfer home, Send, Session (`session`, `session-expired`, `dashboard-done`, `dashboard-partial`), Receive (`receive`, `receive-code`), Join preview (`rx-preview`), Waiting (`rx-wait`), Receiving (`rx-progress`), Result (`rx-done`), History and detail, Devices (This device; account devices; Pair a new device), Settings (guest header with Sign in; account rows), Sign in, Create account, Reset password, Add this device (`trust`), Key setup, Pair this device (code/QR or phrase), Checklist, Sign out, Clipboard (intro, add device, key steps, home, detail). Screen IDs follow `docs/UX_SCREEN_MAP.md` §12; differences from the design are in `docs/design/DESIGN_DEVIATIONS.md` sections L, M and N.

## 3. End-to-end workflows executed

To be completed with the final CI and nightly runs.

## 4. Commands and results

To be completed.

## 5. Environment variables and external services

- Build settings (`ios/project.yml`): `SA_BACKEND_URL` (Debug default `http://127.0.0.1:8080`; Release requires HTTPS), `SA_PUBLIC_URL` (share-link origin; defaults to the backend URL).
- Launch arguments for UI tests only (`-uiTesting`): `-backendURL`, `-resetState`, `-seedHistory`, `-seedSendFiles N`, `-seedFileBytes N`, `-backgroundGrace S`, `-theme light|dark`.
- Caddy: `SA_APPLE_APP_ID` serves `apple-app-site-association` for Universal Links.
- No external services beyond the backend stack.

## 6. Known limitations and untested behaviours

To be completed.

## 7. Backlog

To be completed.

## 8. Local run

```bash
cp .env.example .env
docker compose up -d --build
scripts/ios-tools.sh
(cd ios && ../.tools/xcodegen/bin/xcodegen generate)
open ios/ShareAnywhere.xcodeproj
```

Run the `ShareAnywhere` scheme on an iOS Simulator; the Debug build talks to `http://127.0.0.1:8080`. On Linux, `cd ios/ShareAnywhereCore && swift test` runs the core tests.

## 9. Commits

To be completed.
