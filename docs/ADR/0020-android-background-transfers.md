# ADR 0020: Android background transfers (foreground service, not user-initiated data transfer jobs)

Status: Accepted (Phase 6, milestone 6.3, 2026-11-11); refines ADR 0006

## Context

ADR 0006 chose a `dataSync` foreground service for active transfers and asked Phase 6 to evaluate `JobScheduler` user-initiated data transfer (UIDT) jobs (API 34+). A transfer is a live peer-to-peer session: a WebRTC peer connection, a WebSocket for signaling, and a sender that must answer a receiver's offer at any time while receivers are joined. Android 12+ refuses to start a foreground service from the background, and Android 15 limits `dataSync` services to about 6 hours in 24.

## Options

1. **UIDT jobs (`setUserInitiated(true)`, `RUN_USER_INITIATED_JOBS`).** Designed for a transfer the app can run by itself: the system schedules the job, may defer it until its network constraint holds, and can stop it and expects the app to reschedule. Available from API 34 only, so API 26–33 still need a foreground service.
2. **`dataSync` foreground service** started from the foreground, kept while transfer work exists.

## Decision

Use the **`dataSync` foreground service** on every API level (`TransferService`), not UIDT jobs:

- The service starts from the foreground only: when the receiver taps Start receiving or Resume, when the sender opens the dashboard, and when a receiver joins while the session screen is open. A failed start (the app was already in the background) is caught; the transfer then runs while the app is open.
- It stays while there is transfer work: an unfinished receive, or joined receivers still being served. It stops by itself when none is left.
- It holds a `PARTIAL_WAKE_LOCK` and a Wi-Fi lock (`WIFI_MODE_FULL_LOW_LATENCY`, API 29+) **only while bytes move**, released on pause, completion, failure and stop.
- The ongoing notification shows "Receiving n files · p %" or "Sending to n · p %" and opens the session.
- **Time budget (API 35):** `onTimeout` pauses every transfer (bitmaps are already persisted after each verified block), stops the service, and posts "Transfer paused — Android's background time limit was reached". Opening the app and tapping Resume continues from the bitmap.

## Reasons

- A UIDT job's run is scheduled by the system and may be deferred or stopped; a waiting sender must answer an offer within seconds, and a peer connection cannot be handed from one job execution to the next.
- One mechanism for API 26–35 keeps the behaviour (and its tests) the same everywhere.
- The foreground service's own budget is handled by the same checkpoint the protocol already needs for reconnects (docs/TRANSFER_PROTOCOL.md §4, §6).

## Consequences

- The budget handling is covered by the nightly API 35 emulator run (milestone 6.5); OEM battery managers that kill foreground services remain **untested device behaviour**.
- Revisit UIDT if the time budget becomes the main limit for very large transfers on API 35+.
