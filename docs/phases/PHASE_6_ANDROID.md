# Phase 6 — Android app

Read: PRD §2 (Android SDK, long transfers), §4, §5 (all), §6.4, §7.3, §7.5; `docs/TESTING_AND_CI.md` §1, §2, §5; `docs/TRANSFER_PROTOCOL.md`; `docs/CLIPBOARD_PROTOCOL.md`.

This phase is only verifiable with the Android emulator workflow. If the Android SDK is not available locally, still write the code, make `./gradlew` work in CI, and let `android-emulator` be the verification. Do not mark anything tested until that workflow is green.

## Scope
- Gradle project: Kotlin 2.x, Compose BOM, Hilt, Room, Retrofit/OkHttp or Ktor (ADR), WorkManager, CameraX + ML Kit barcode or ZXing for QR, version catalog + lockfiles, minSdk 26, targetSdk 35, `assembleDebug` reproducible; no release signing in repo.
- Generated API client from `openapi.yaml` (openapi-generator kotlin) kept in sync by the `protocol` job.
- Auth (bearer device token), device registration, Devices, Settings, History screens.
- Send flow with SAF multi-select, session creation, QR/code/link display, approvals; Receive flow with QR scan, code entry, App Links (`assetlinks.json` served by Caddy; verification documented as untested until a real device), destination via `ACTION_CREATE_DOCUMENT`/tree URI, progress, verification.
- Transfer engine in Kotlin (`transfer/engine`) implementing the Phase 3 wire protocol with WebRTC (`io.getstream:stream-webrtc-android` or `org.webrtc` artifact; ADR), streaming I/O through `ContentResolver`, bitmap persistence in Room, resume, backpressure.
- Foreground service type `dataSync` for active transfers with notification progress; time-budget handling per PRD §2 (checkpoint, stop, notify, resume); evaluation of `JobScheduler` user-initiated data transfer with the outcome recorded in ADR.
- Clipboard: foreground capture with lifecycle-aware listener, sensitive flag skip, manual Sync action, notification action that opens the Activity, history/detail/Copy, pairing (scan QR from Web), Keystore-wrapped ACK, recovery phrase entry.
- Material 3 theme from the design tokens, EN/VI `values`, dynamic font scaling, 48 dp targets, TalkBack labels.

## Out of scope
Route strategy beyond direct P2P with the default ICE servers (TURN credentials are fetched but forcing/fallback logic arrives in Phase 7), Cloud, IME.

## Tests to add
- JVM unit: engine scheduler/bitmap/hasher, frame codec interop vectors shared with Web (`shared/protocol/schemas/transfer-vectors.json`), clipboard crypto vectors shared with Web.
- Instrumentation (API 34 in `ci.yml`): sign in against backend at `10.0.2.2`; create session and read code; join via code; SAF create-document flow via UiAutomator; clipboard foreground capture and background non-capture; notification action opens Activity; Compose screenshot tests for each screen in light/dark and `fontScale 1.3`.
- Nightly `android-web-interop`: emulator sender → Playwright receiver and reverse, 64 MB fixture, hash match; `android-matrix` on API 29/34/35; FGS time-budget simulation on API 35; `clipboard-cross-client`.

## CI changes
`android`, `android-emulator` jobs in `ci.yml` become required; `android-emulator.yml` reusable workflow; nightly jobs above.

## Exit gate
`ci.yml` green including emulator; both interop directions green in nightly with run links; screenshots attached to the report; every platform limitation from PRD §6.8 and §7.3 reflected in UI copy.
