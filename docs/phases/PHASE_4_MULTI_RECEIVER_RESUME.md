# Phase 4 — Multi-receiver, reconnect and resume hardening

Read: PRD §5.5, §6.4, §6.5, §13 (Transfer); `docs/TESTING_AND_CI.md` §2.2.

## Scope
- Sender-side scheduler for up to five independent receiver pipelines sharing one file reader with a bounded block cache (LRU, configurable MB), so a slow receiver never stalls others and the file is not read five times from disk where avoidable.
- Per-receiver pause/resume/remove; stop all; close session; partial completion semantics (`PARTIALLY_COMPLETED`).
- Aggregate progress and group ETA (slowest active receiver + queued work).
- Reconnect hardening: exponential backoff with jitter, signaling re-auth, bitmap reconciliation on both sides, duplicate block tolerance.
- History feature (PRD §5.6) on Web with search/filter and transferred-vs-size distinction.
- Server-side: `GET /v1/sessions/{id}/transfers`, session aggregate, cleanup of expired sessions and orphan transfers.

## Out of scope
TURN forcing, Cloud, Android.

## Tests to add
- Vitest: scheduler fairness (slow consumer does not reduce fast consumer throughput below threshold in a simulated clock), block cache bounds.
- Playwright nightly `five-receivers`: one sender, five receivers (three chromium, one firefox, one webkit), one throttled via CDP; assert completion order and sixth rejection. PR variant: two receivers, one throttled.
- Playwright: remove a receiver mid-transfer → its state `CANCELLED`, others unaffected; close session → all receivers see `SESSION_CLOSED`.
- Backend: aggregate state derivation tests for every combination of transfer states → session state.

## CI changes
`nightly.yml` `five-receivers` job real; PR `e2e-web` adds two-receiver spec.

## Exit gate
Nightly five-receiver run green and linked; PR suite green; History page functional in all projects.
