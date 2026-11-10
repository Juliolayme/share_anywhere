# ADR 0006: Android SDK levels and foreground-service limits

Status: Accepted (Phase 0, 2026-11-10)

## Context

Long transfers on Android need a foreground service, and recent Android versions limit `dataSync` foreground services (about 6 hours per 24 hours on Android 15). Clipboard access is restricted to the foreground since Android 10. PRD §2 fixes minSdk 26 and targetSdk 35.

## Decision

- minSdk 26, targetSdk 35, Kotlin 2.x, Compose BOM, AGP 8.x, JDK 17 in CI.
- Active transfers run in a `dataSync` foreground service holding a partial wake lock and a Wi-Fi lock only while bytes move; the engine checkpoints the bitmap, stops cleanly at the time budget, notifies the user, and resumes later.
- Phase 6 evaluates `JobScheduler` user-initiated data transfer jobs (API 34+) and records the outcome in a new ADR.
- The transfer screen sets `FLAG_KEEP_SCREEN_ON` while visible and active (`docs/ARCHITECTURE.md` §7).
- Clipboard capture only while an Activity is resumed; never from a service.

## Consequences

- The FGS time budget must be simulated in the emulator matrix (`docs/TESTING_AND_CI.md` §2.2).
- OEM battery managers may still kill transfers; this is listed as untested device behavior.
