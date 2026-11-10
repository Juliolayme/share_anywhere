# Phase 8 — Route strategy, TURN fallback, optional Cloud Distribution

Read: PRD §2 (iOS long transfers), §6.2, §6.3, §6.5, §6.6, §6.7; `docs/ARCHITECTURE.md` §6; `docs/SECURITY_MODEL.md` §5–§7; `docs/API.md` §2.6; `docs/TESTING_AND_CI.md` §2.2.

Starts only when Phases 6 and 7 are both merged.

## Scope

- Client route controller (Web, Android, iOS): ICE candidate-pair observation via `getStats()`, classification Direct / TURN-UDP / TURN-TCP-TLS, EWMA throughput and RTT, hysteresis and cooldown, migration (new PeerConnection, re-handshake, bitmap exchange), route badge and events.
- coturn configuration for UDP 3478 and TCP/TLS 443 (Caddy passes through or coturn binds 443 directly; ADR), credential TTL alignment.
- Server records route per transfer for metrics; Prometheus `/metrics`.
- Guest TURN limits from `docs/ARCHITECTURE.md` §6 and `docs/SECURITY_MODEL.md` §5: 30-min credential TTL, relay byte cap per session via coturn usage stats (`prometheus-username-labels`), stop renewing credentials above the cap and show the user why.
- Cloud Distribution (optional, feature-flagged off by default, **signed-in senders only**; guests see the disabled option with "Sign in to use Cloud transfer" and `POST /v1/files/{id}/distribute` returns `403 cloud_requires_account`; guest receivers download through `GET /v1/cloud/objects/{id}` as joined participants): S3-compatible adapter (MinIO in compose), per-file client-side key shared over signaling to joined receivers, multipart upload streaming, TTL and deletion, cost estimate from configurable pricing, consent dialog, budget cap with pause, Web, Android, and iOS UI. On iOS the consent dialog explains that Cloud Distribution lets a transfer finish while the app is not in the foreground. Document "cost unknown" behavior.
- Settings: transfer strategy Auto (only mode in v1, shown for transparency), Cloud toggle + budget.

## Out of scope

P2P cascade, Kubernetes, external cloud providers' real pricing.

## Tests to add

- Vitest/JVM/`swift test`: route classifier from stats fixtures; hysteresis prevents flapping under noisy samples; ETA uncertainty states.
- Playwright nightly `turn-forced`: `relay` policy, UDP and TCP/TLS variants, transfer completes, badge shows "Using relay"; mid-transfer block direct candidates via test hook → migration resumes from bitmap.
- Backend + MinIO: upload with TTL, object deleted after completion; budget exhaustion pauses and emits event; consent absent → `403 cloud_consent_required`; guest sender → `403 cloud_requires_account`; guest receiver who joined the session downloads successfully; guest relay byte cap stops credential renewal.
- Android instrumentation nightly: forced relay transfer on emulator.
- iOS XCUITest nightly: forced relay transfer on simulator; Cloud Distribution consent flow and background completion through cloud for a signed-in sender; guest sender sees "Sign in to let large transfers finish in the background".

## CI changes

`nightly.yml` `turn-forced` real; MinIO added to `docker-compose.ci.yml` behind the cloud flag.

## Exit gate

Relay tests green on both transports on all three clients; migration test green; cloud tests green; metrics endpoint scraped in a test; report written.
