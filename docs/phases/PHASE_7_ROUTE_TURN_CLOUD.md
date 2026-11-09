# Phase 7 — Route strategy, TURN fallback, optional Cloud Distribution

Read: PRD §6.2, §6.3, §6.5, §6.6, §6.7; `docs/TESTING_AND_CI.md` §2.2.

## Scope
- Client route controller (Web and Android): ICE candidate-pair observation via `getStats()`, classification Direct / TURN-UDP / TURN-TCP-TLS, EWMA throughput and RTT, hysteresis and cooldown, migration (new PeerConnection, re-handshake, bitmap exchange), route badge and events.
- coturn configuration for UDP 3478 and TCP/TLS 443 (Caddy passes through or coturn binds 443 directly; ADR), credential TTL alignment.
- Server records route per transfer for metrics; Prometheus `/metrics`.
- Cloud Distribution (optional, feature-flagged off by default): S3-compatible adapter (MinIO in compose), per-file client-side key shared over signaling to approved receivers, multipart upload streaming, TTL and deletion, cost estimate from configurable pricing, consent dialog, budget cap with pause, Web and Android UI. Document "cost unknown" behavior.
- Settings: transfer strategy Auto (only mode in v1, shown for transparency), Cloud toggle + budget.

## Out of scope
P2P cascade, Kubernetes, external cloud providers' real pricing.

## Tests to add
- Vitest/JVM: route classifier from stats fixtures; hysteresis prevents flapping under noisy samples; ETA uncertainty states.
- Playwright nightly `turn-forced`: `relay` policy, UDP and TCP/TLS variants, transfer completes, badge shows "Using relay"; mid-transfer block direct candidates via test hook → migration resumes from bitmap.
- Backend + MinIO: upload with TTL, object deleted after completion; budget exhaustion pauses and emits event; consent absent → `403 cloud_consent_required`.
- Android instrumentation nightly: forced relay transfer on emulator.

## CI changes
`nightly.yml` `turn-forced` real; MinIO added to `docker-compose.ci.yml` behind the cloud flag.

## Exit gate
Relay tests green on both transports; migration test green; cloud tests green; metrics endpoint scraped in a test; report written.
