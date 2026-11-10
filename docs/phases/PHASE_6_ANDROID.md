# Phase 6 — Android app

Read: PRD §2 (guest-first, device identity, signing in/out, history, Android SDK, long transfers), §4, §5 (all), §6.4, §5.10; `docs/ARCHITECTURE.md` §2, §3, §4, §7; `docs/SECURITY_MODEL.md` §3, §4; `docs/API.md`; `docs/UX_SCREEN_MAP.md` (all, Android column); §7.3, §7.5; `docs/TESTING_AND_CI.md` §1, §2, §5; `docs/TRANSFER_PROTOCOL.md`; `docs/CLIPBOARD_PROTOCOL.md`.

Depends on Phase 5 (both milestones) only. May run in parallel with Phase 7 (iOS) on a separate branch. This phase is only verifiable with the Android emulator workflow. If the Android SDK is not available locally, still write the code, make `./gradlew` work in CI, and let `android-emulator` be the verification. Do not mark anything tested until that workflow is green.

## Scope

- Gradle project: Kotlin 2.x, Compose BOM, Hilt, Room, Retrofit/OkHttp or Ktor (ADR), WorkManager, CameraX + ML Kit barcode or ZXing for QR, version catalog + lockfiles, minSdk 26, targetSdk 35, `assembleDebug` reproducible; no release signing in repo.
- Generated API client from `openapi.yaml` (openapi-generator kotlin) kept in sync by the `protocol` job.
- Guest-first start: Welcome once on first launch → Transfer home; anonymous device identity created in the background; refresh secret in Keystore-backed `EncryptedFile`/DataStore; access token in memory with silent refresh; 429 messaging.
- Local History in Room (guest variant), with cloud sync merge when signed in.
- Devices (This device card for guests; account list when signed in), Settings (Guest header with Sign in / account sections).
- Account screens as a nested graph reached only from account CTAs: sign in, sign up, reset, post-sign-in choices, ADK setup or pairing / recovery phrase, sign-out with keep/clear local history and new anonymous identity.
- Send flow with SAF multi-select, session creation with the Require approval toggle (default off), QR/code/link display with the 10:00 join-window countdown, "Code expired — Create new code" state and button, "Session full" state, participant list with badges, security words, Remove and Block, join snackbar and a local notification when a receiver joins while the app is in the background, request cards when approval is on, Stop accepting; Receive flow with QR scan, code entry, App Links (`assetlinks.json` served by Caddy; verification documented as untested until a real device), destination via `ACTION_CREATE_DOCUMENT`/tree URI, progress, verification.
- Transfer engine in Kotlin (`transfer/engine`) implementing the Phase 3 wire protocol with WebRTC (`io.getstream:stream-webrtc-android` or `org.webrtc` artifact; ADR), streaming I/O through `ContentResolver`, bitmap persistence in Room, resume, backpressure.
- Keep screen on: `FLAG_KEEP_SCREEN_ON` through `View.keepScreenOn` in a Compose `DisposableEffect` while a send, receive, or waiting screen is visible and the keep-awake controller is active; cleared on completion, failure, pause, cancel, removal, session end, leaving the screen, or setting off; status row with "You can turn the screen off; the transfer continues"; setting **Keep screen on during transfers** (default on).
- Foreground service type `dataSync` for active transfers with notification progress, holding a `PARTIAL_WAKE_LOCK` and a Wi-Fi lock only while bytes move; time-budget handling per PRD §2 (checkpoint, stop, notify, resume); evaluation of `JobScheduler` user-initiated data transfer with the outcome recorded in ADR.
- Clipboard tab: account-required intro for guests (no `ClipboardManager` access and no listener registration while a guest); "Add this device" for not-added devices; when ready, foreground capture with lifecycle-aware listener, sensitive flag skip, manual Sync action, notification action that opens the Activity, history/detail/Copy, pairing (scan QR from Web), Keystore-wrapped ACK, recovery phrase entry.
- Material 3 theme from the design tokens, EN/VI `values`, dynamic font scaling, 48 dp targets, TalkBack labels.

## Out of scope

Route strategy beyond direct P2P with the default ICE servers (TURN credentials are fetched but forcing/fallback logic arrives in Phase 8), Cloud, IME.

## Tests to add

- JVM unit: engine scheduler/bitmap/hasher, frame codec interop vectors shared with Web and iOS (`shared/protocol/schemas/transfer-vectors.json`), clipboard crypto vectors shared with Web and iOS.
- Instrumentation (API 34 in `ci.yml`): fresh install goes Welcome → Transfer home with no sign-in screen; as a **guest**, create session and read code, join via code with open join (no approval step), let the join window expire (injected clock) and assert the expired state, Create new code, and that an already-joined receiver keeps transferring, Remove and Block a receiver, turn on Require approval and approve, and transfer to a Playwright guest peer (interop job); `FLAG_KEEP_SCREEN_ON` is set on the window while the transfer screen is visible and cleared after completion, pause, cancel, and with the setting off; with the screen turned off (`UiDevice.sleep()`) the transfer still completes; `dumpsys power` shows no wake lock held after completion; local History entry survives app restart; Clipboard tab shows the intro and no clipboard listener is registered while a guest; then sign in against backend at `10.0.2.2`, add the device, and reach the Clipboard history; sign-out yields a new device ID; SAF create-document flow via UiAutomator; clipboard foreground capture and background non-capture; notification action opens Activity; Compose screenshot tests for each screen in light/dark and `fontScale 1.3`.
- Nightly `android-web-interop`: emulator sender → Playwright receiver and reverse, 64 MB fixture, hash match; `android-matrix` on API 29/34/35; FGS time-budget simulation on API 35; `clipboard-cross-client`.

## CI changes

`android`, `android-emulator` jobs in `ci.yml` become required; `android-emulator.yml` reusable workflow; nightly jobs above.

## Exit gate

Guest send and receive verified on the emulator without any sign-in. `ci.yml` green including emulator; both interop directions green in nightly with run links; screenshots attached to the report; every platform limitation from PRD §6.8 and §7.3 reflected in UI copy.
