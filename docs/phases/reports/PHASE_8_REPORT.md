# Phase 8 report: route strategy, TURN fallback, Cloud Distribution

Status: exit gate met. CI [43275258671](https://github.com/Juliolayme/share_anywhere/actions/runs/43275258671) on c405866 green in all 16 jobs (including `android-emulator (API 34)` with the forced-relay tests and `ios-simulator` with the forced-relay and Cloud UI tests); Nightly [43275288440](https://github.com/Juliolayme/share_anywhere/actions/runs/43275288440) on c405866 green in all 15 jobs (`turn-forced` over UDP and TLS with the migration test, `android-matrix` 29 and 35, the iOS matrix on iPhone 16 Pro Max, iPhone SE (3rd generation), iPhone 16 on the oldest runtime and at XXXL, `ios-background-suspend`, `ios-web-interop`, `android-web-interop`, `clipboard-cross-client`). Relay tests are green on both transports on all three clients, the migration test is green, the Cloud tests are green (backend against an S3-compatible gateway, Web, iOS), and `/metrics` is scraped in tests. QA: `docs/qa/PHASE_8_QA.md`.

Every "tested" claim below was executed in GitHub Actions (Ubuntu runners for the backend, Web and Android emulator; the macOS 15 runner with Xcode 16.4 and the iOS 18.5 simulator for iOS) or in the cloud development container (Linux: Go against PostgreSQL 16, the Versity S3 gateway and coturn in Docker; Playwright Chromium and stock Firefox; `swift test` on Linux). Nothing ran on a real phone.

## 1. What was implemented

**Implemented and tested**

- **Route engine on three clients (8.1).** Web `web/src/features/transfer/engine/route.ts`, Android `transfer/engine/Route.kt`, iOS `SATransferRuntime/Route.swift`, one behaviour pinned by `shared/protocol/schemas/route-vectors.json`: the selected ICE candidate pair from `getStats()` classified as direct, relay over UDP, TCP or TLS; EWMA throughput and RTT (alpha 0.3); a stall (12 s without progress) or two losses of an open channel within 120 s escalate one step on the policy ladder (all → relay over UDP → relay over TLS) with a 30 s cooldown against flapping; two dials on a stricter step that never open return to the start step (Firefox ignores loopback TURN); migration builds a new PeerConnection, re-handshakes and resumes from the bitmap. The route chip shows Direct / Using relay / Cloud; the route is reported with each transfer and counted in `/metrics`.
- **coturn and credentials (8.2, ADR 0029).** UDP and TCP on 3478 and TLS terminated by coturn (5349 in development and CI, 443 on its own address in production), `use-auth-secret` credentials with TTL 30 min for guest devices and 60 min for account devices, renewed by clients 120 s before expiry while the connection is relayed. The relay byte cap per session reads coturn's Prometheus exporter (`prometheus-username-labels`, `SA_TURN_METRICS_URL`): above the cap the backend refuses `POST /v1/turn/credentials` with `relay_cap_reached` and receivers show why (the transfer continues directly when it can).
- **Metrics.** Prometheus `/metrics` on the backend with transfers by route and outcome, relay bytes and Cloud counters; the registry is covered by backend unit tests; `/metrics` is scraped by the CI `compose` job and the Playwright `turn-forced` and Cloud specs.
- **Cloud Distribution (8.3, ADR 0030).** Off unless `SA_CLOUD_ENABLED`. A signed-in sender on an added device consents (estimate from configured prices, "cost unknown" when none, monthly budget), the client encrypts each 4 MiB part with AES-256-GCM under a per-file key and uploads it through the backend to an S3-compatible store (Versity Gateway in compose and CI; MinIO no longer publishes images); joined receivers, guests included, get the key over signaling (X25519 + HKDF, wrapped per receiver) and finish from the cloud when P2P cannot connect or the sender left, resuming at the next part after an interruption. Guests see the option disabled ("Sign in to use Cloud transfer"; on iOS "Sign in to let large transfers finish in the background") and `POST /v1/files/{id}/distribute` answers `403 cloud_requires_account`; a not-added device gets `403 device_not_added`; no consent gets `403 cloud_consent_required`. Objects expire after `SA_CLOUD_TTL` (24 h) and are deleted once every joined receiver has the file (a cloud receipt or a `COMPLETED` P2P transfer); budget exhaustion pauses uploads and downloads and emits `CLOUD_UPDATED`. Web, Android and iOS UI: the consent dialog (on iOS it explains that Cloud lets the transfer finish while the app is not in the foreground), the upload card, Settings with the transfer strategy (Auto) and the Cloud toggle and budget.

**Implemented but untested**

- Android Cloud UI and the Android cloud receive path run only in JVM unit tests (`CloudVectorsTest`) and compile in CI; no emulator test drives a Cloud transfer (the phase file asks for Cloud UI tests on the Web and iOS).
- TURN over TLS on port 443 with a real certificate (production layout); CI uses 5349 with a self-signed certificate.
- The relay byte cap against real coturn traffic at the cap: the cap logic is tested with a fake exporter and the exporter parsing against coturn's format; CI does not push gigabytes through coturn.
- Real networks: NAT types, captive portals, carrier networks, IPv6-only paths; every relay test runs on loopback.

**Partially implemented / planned**

- The sender has no relay-cap notice (receivers have it).
- Cloud resume continues from its own last part within one run (in-memory cursor); parts already received over P2P are downloaded again, and an app restart starts the cloud download at part 0.
- The Cloud key is not bound to the security words.

## 2. Usable screens and routes

- **Web:** Send (Cloud transfer option with consent dialog), Session (Cloud upload card, route chip), Receiving (route chip incl. Cloud), Settings (Transfer strategy: Auto; Cloud Distribution toggle and monthly budget for signed-in added devices), History (route Cloud).
- **Android:** the same set in Compose (Send option and consent dialog, Session upload card, Settings section, route chip).
- **iOS:** the same set in SwiftUI (Send option with the background explanation, Session upload card, Settings section, route chip).
- **API:** `GET/PUT /v1/cloud/settings`, `POST /v1/cloud/estimate`, `POST /v1/files/{id}/distribute`, `PUT/GET /v1/cloud/objects/{id}/parts/{n}`, `POST /v1/cloud/objects/{id}/seal`, `GET /v1/sessions/{id}/cloud`, `GET /v1/cloud/objects/{id}`, `POST /v1/cloud/objects/{id}/received`, `/metrics`; access levels in `docs/API.md` §2.6 and OpenAPI `x-sa-access`.

## 3. End-to-end workflows executed

All file transfers below run as guests unless marked signed in; the backend is the Go server with PostgreSQL 16, coturn (UDP 3478, TLS 5349, loopback peers allowed in CI) and, for Cloud, the Versity S3 gateway (CI compose and the backend job) or the in-memory store (iOS simulator lane).

- **Web, Playwright Chromium** (`turn-forced`, nightly and local): relay-only transfer over TURN UDP and over TURN TLS completes with the "Using relay" chip and route `relay` in `/metrics`; a direct transfer whose direct path is blocked mid-transfer migrates to the relay and resumes from the bitmap with no block verified twice.
- **Web, all five projects** (`e2e-web`: chromium-desktop, firefox-desktop, webkit-desktop, android-chrome, ios-safari): the existing P2P suites with the route engine in place, including the sender dropping off and resuming (Firefox exercises the step back from an unusable relay).
- **Web Cloud, Chromium** (`e2e/cloud`): a guest sender sees Cloud transfer disabled with "Sign in to use Cloud transfer"; signed in with the device added, the sender consents (estimate shown), uploads, and leaves; a guest receiver whose P2P cannot connect finishes from the cloud with a matching SHA-256 and route `cloud`; the object is deleted and the Cloud counters move in `/metrics`.
- **Android emulator** (API 34 in CI, API 29 and 35 in the nightly matrix): `ForcedRelayTest` relay over UDP and over TLS carries a transfer with route kind relay-udp / relay-tls; the Phase 6 instrumentation suite still passes.
- **iOS Simulator** (iOS 18.5): `RelayUITests` relay over UDP and over TLS — iPhone 16 Pro Max and iPhone 16 on the oldest runtime in Nightly 43247797311 (1ce5705), iPhone 16 Pro Max in Nightly [43262617958](https://github.com/Juliolayme/share_anywhere/actions/runs/43262617958) (6aac3e3), iPhone 16 in CI [43270835440](https://github.com/Juliolayme/share_anywhere/actions/runs/43270835440) (981add9). `CloudUITests`: a guest sender sees the Cloud option disabled with "Sign in to let large transfers finish in the background"; signed in (sign up, add this device, recovery-phrase key), the sender turns on Cloud transfer, sees the consent sheet with the background line and "Cost unknown", approves, the upload card reaches ready, a `TestPeer` receiver with no network path joins and gets the key over signaling, the app goes to the Home Screen, and the receiver finishes from the cloud (route `cloud`, matching SHA-256); back in the app the sender sees the result. Green on the full suite (21 tests) on iPhone 16 Pro Max in Nightly [43262617958](https://github.com/Juliolayme/share_anywhere/actions/runs/43262617958) at 6aac3e3; also green on iPhone 16 in CI [43275258671](https://github.com/Juliolayme/share_anywhere/actions/runs/43275258671) and on the whole Nightly iOS matrix (Pro Max, SE, oldest runtime) in [43275288440](https://github.com/Juliolayme/share_anywhere/actions/runs/43275288440), both at c405866.
- **Backend** (Go tests against PostgreSQL 16 and the Versity gateway): distribute preconditions (`cloud_requires_account`, `cloud_consent_required`, `device_not_added`, `cloud_budget_exhausted`), upload, seal, download by a guest receiver who joined, deletion after delivery (cloud receipt or a `COMPLETED` P2P transfer; at seal for an object still uploading), TTL and ended-session sweep, budget pause and the month turn, the relay byte cap stopping credential renewal, `/metrics` scraped.

## 4. Commands and results

Local (cloud development container, Linux):

- `cd backend && gofmt -l . && go vet ./... && golangci-lint run ./...` (v2.15.0): clean, 0 issues.
- `TEST_DATABASE_URL=… go test -count=1 ./...` against PostgreSQL 16: all packages pass; the Cloud and object-store tests also against the Versity S3 gateway (`TEST_S3_ENDPOINT=…`, 10 `TestCloud*` and `TestS3StoreAgainstGateway`).
- `cd web && pnpm -s format:check && pnpm -s lint && pnpm -s typecheck && pnpm -s test`: clean, 60 files, 493 tests.
- `E2E_TURN=1 npx playwright test e2e/cloud e2e/nightly/turn-forced.spec.ts e2e/transfer/p2p.spec.ts --project=chromium-desktop --retries=0` against the CI compose stack: Cloud 2/2, turn-forced 3/3, p2p 8 passed (1 skipped: the in-memory private-window case runs only on browsers without storage); p2p 7/7 on stock Firefox earlier in the phase.
- `cd ios/ShareAnywhereCore && swift test` with SwiftFormat lint and SwiftLint strict: 108 tests, 0 failures.
- ktlint 1.5.0 on the changed Kotlin: clean. Android and the iOS app build only in CI.
- `npx markdownlint-cli2 "docs/**/*.md"`: 0 issues.

CI and nightly (GitHub Actions):

- CI [43275258671](https://github.com/Juliolayme/share_anywhere/actions/runs/43275258671) on c405866: all 16 jobs green (`backend`, `web`, `protocol`, `security`, `docs`, `compose`, five `e2e-web` projects, `android`, `android-emulator (API 34)` with `ForcedRelayTest` UDP and TLS, `ios`, `ios-simulator` with the full UI suite including `RelayUITests` and `CloudUITests`).
- Nightly [43275288440](https://github.com/Juliolayme/share_anywhere/actions/runs/43275288440) on c405866: all 15 jobs green (`turn-forced` UDP, TLS and migration; `android-matrix` 29 and 35; iOS matrix on iPhone 16 Pro Max, iPhone SE (3rd generation), iPhone 16 on the oldest runtime and at XXXL; `ios-background-suspend`; `ios-web-interop`; `android-web-interop`; `clipboard-cross-client`; `large-file`; `five-receivers`; `mobile-snapshots`).
- Earlier evidence: Nightly [43262617958](https://github.com/Juliolayme/share_anywhere/actions/runs/43262617958) on 6aac3e3 (iPhone 16 Pro Max full suite 21/21; `turn-forced`, `android-matrix` 29 and 35, `android-web-interop`, `ios-web-interop`, `ios-background-suspend` green); CI [43270835440](https://github.com/Juliolayme/share_anywhere/actions/runs/43270835440) on 981add9 (`ios-simulator` 21/21). The QA record lists every run of the loop (`docs/qa/PHASE_8_QA.md`).

## 5. Environment variables and external services

- TURN: `SA_TURN_SECRET` (coturn `static-auth-secret`), `SA_TURN_URIS` (add `turns:<host>:443?transport=tcp` in production), `SA_TURN_METRICS_URL` (coturn exporter on an internal network; empty disables the cap), `SA_GUEST_RELAY_BYTES_CAP`, `SA_ACCOUNT_RELAY_BYTES_CAP`. coturn needs a certificate for TLS (`scripts/turn-test-cert.sh` makes a self-signed one for development).
- Cloud: `SA_CLOUD_ENABLED` (default false), `SA_CLOUD_STORE` (`s3`; `memory` for development and tests only), `SA_S3_ENDPOINT`, `SA_S3_REGION`, `SA_S3_BUCKET`, `SA_S3_ACCESS_KEY`, `SA_S3_SECRET_KEY`, `SA_CLOUD_TTL`, `SA_CLOUD_DEFAULT_BUDGET_BYTES`, `SA_CLOUD_MAX_BUDGET_BYTES`, `SA_CLOUD_PRICE_STORAGE_GB_MONTH`, `SA_CLOUD_PRICE_EGRESS_GB`, `SA_CLOUD_CURRENCY`. All in `.env.example`.
- External services: an S3-compatible store for Cloud (Versity Gateway in `docker compose --profile cloud`); coturn with TLS.

## 6. Known limitations and untested behaviours

- **No real devices or real networks.** Relay and migration tests run on loopback (CI coturn allows loopback peers, `infra/coturn/turnserver.ci.conf`); the production config denies private and loopback peers.
- **Firefox and loopback TURN:** Firefox ignores TURN servers on loopback (ice-error 701), so `turn-forced` runs on Chromium; Firefox's route fallback is covered by the p2p suite.
- **Cloud is server-proxied:** every byte passes through the backend (no presigned URLs or CDN), which bounds throughput to the backend's bandwidth.
- **Cloud resume** keeps the part cursor in memory: after an app restart a cloud download starts again at part 0 (and is charged again); parts already received over P2P are downloaded again from the cloud.
- **S3 deletion** is asserted through the store wrapper, not by a 404 from the gateway.
- **Android test harness (resolved):** the orchestrator's `clearPackageData` and the interop scripts' `pm clear` raise PACKAGE_DATA_CLEARED, which MediaProvider handled up to ~15 s late and then orphaned the Downloads item a test was receiving into (`SecurityException`, seen once in `android-web-interop` and once in `ForcedRelayTest`). `SettledMediaRunner` waits for MediaProvider before each test; not a product defect (a user's own data clear does not race a running transfer).
- **coturn exporter** grows one series per ephemeral username; restart coturn periodically (ADR 0029).
- **iOS background completion** through the cloud is tested by sending the app to the Home Screen in the simulator (the receiver has no network path to the sender); real suspension timing and a long transfer under real background limits are on the real-device checklist.

## 7. Backlog

- **P0:** none known.
- **P1:** run TURN over TLS on 443 with a real certificate in a staging environment.
- **P2:** after a socket reconnect, replace the receiver's cloud object list rather than merging it (an object deleted while the socket was down is retried until P2P returns; nothing is charged), and drop an object locally on `unavailable`; a sender-side relay-cap notice; an Android emulator test for a Cloud transfer; on Android, ignore events from a torn-down receiver connection and serialise `SafSink` close with writes; re-check deletion after a receipt that races with seal (the object otherwise stays until the sweep); a part claimed but never stored (crash between claim and store) and charging before a failed part read; assert S3 deletion with a 404 Get; relay cap against real coturn traffic at the cap; skip P2P-covered parts and persist the cursor in cloud resume; bind the Cloud key to the security words; presigned or CDN delivery for Cloud.

## 8. Local run

```bash
cp .env.example .env
scripts/turn-test-cert.sh
docker compose --profile cloud up -d --build
```

Set `SA_CLOUD_ENABLED=true` and the `SA_S3_*` keys in `.env` to turn Cloud on (the `s3` service uses them as its root keys). The Web app is at the Caddy address from `README.md`; sign up and add the device to see the Cloud option. `docker compose up -d --build` without the profile runs everything except the S3 gateway.

## 9. Commits

On `claude/practical-lovelace-avlb5g`: bea6095, 4ff9796, 612b47e (Web route engine, relay cap, metrics); cc4e173 (Android route); a666755 (iOS route); e952331 (route fix); 683b770, e5c1ecf, ca0e4cf (Cloud backend and contract); 56848eb, 9674369 (Web Cloud); ceb88d0 (iOS Cloud); d3b0e7a (Android Cloud); 971cd8e (docs); QA and CI: ffd47b2, 0e60e08, 8ff898c, 1ce5705, 8bfd25c, c221089, 6aac3e3, 981add9, c405866; report and QA record: the commit that adds this report (`docs: Phase 8 report and QA record`).
