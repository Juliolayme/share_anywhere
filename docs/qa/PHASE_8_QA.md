# QA — Phase 8 (route strategy, TURN fallback, Cloud Distribution)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs. Android and the iOS app targets build only in CI (no Android SDK or Xcode in the development container); the agent marks those items "not verified" until a CI run on the reviewed commit is green.

## CI history of the QA loop

- bea6095 to cc4e173: Web route engine and turn-forced, relay cap and metrics, Android route port. Nightly `turn-forced` green on bea6095, 4ff9796, cc4e173; CI runs superseded (cancelled) by the next push.
- a666755 (iOS route port): every job green except `e2e-web (firefox-desktop)`: `p2p.spec.ts:249` (the sender drops off) never resumed. The receiver diagnostics showed two "losses" (a channel error, then an open timeout while the sender was away) escalating to relay-only, and Firefox ignores loopback TURN (ice-error 701), so relay-only dials never connected. Fixed in e952331 (only open channels count as losses; two unopened dials on a stricter step return to the start step); verified locally with stock Firefox (p2p 7/7).
- 683b770: `security` failed (gitleaks on the published cloud vectors and a placeholder secret in a config test; allowlisted and rewritten in e5c1ecf); `protocol` failed (stale backend `types.gen.go`; regenerated in ca0e4cf); `android` failed (`GeneratedSourcesTest`: the parts path listed PUT before GET; reordered in 56848eb).
- ca0e4cf: `backend` (Cloud tests against the Versity S3 gateway), `protocol`, `security`, `compose` green.
- 9674369: `web`, `e2e-web` chromium (Cloud spec included), `android`, `ios`, `backend`, `compose`, `security` green; superseded before the device lanes finished.
- ffd47b2: `backend`, `web`, `compose`, all five `e2e-web` projects (Firefox `p2p.spec.ts:249` green with the route fix) and `android` (Android Cloud code compiled, `CloudVectorsTest` green) green; `android-emulator` superseded; `ios` and `ios-simulator` cancelled by GitHub (no macOS runner acquired).
- 1ce5705 (CI 43247797239, Nightly 43247797311): CI `backend`, `web`, `protocol`, `security`, `compose`, `docs`, `android`, `android-emulator (API 34)` (ForcedRelayTest UDP and TLS) and all five `e2e-web` projects green; `ios` cancelled (runner capacity). Nightly `turn-forced`, `android-matrix` 29 and 35, `ios-web-interop`, `clipboard-cross-client`, `large-file`, `five-receivers`, `mobile-snapshots` and the XXXL screenshots green. First iOS simulator runs of the Phase 8 UI tests (Pro Max and oldest lanes): `RelayUITests` UDP and TLS green; both `CloudUITests` failed (the Cloud option never appeared: its `.task` sat on an empty `Group`; fixed in 8bfd25c); `AccountUITests` pairing failed once on Pro Max and passed on the oldest lane (flake, not Phase 8 code). `android-web-interop` failed once: the Android receiver hit `storage_error` after all 64 MB arrived (green on every earlier nightly; storage errors now log the exception class, 8bfd25c).
- 8bfd25c (CI 43254027807, Nightly 43254587007): `ios` green for the first time in Phase 8; `backend`, `web`, `protocol`, `security`, `docs`, `compose`, `android` and all five `e2e-web` projects green; Nightly `turn-forced`, `android-matrix` 29 and 35, `android-web-interop`, `clipboard-cross-client`, `large-file`, `five-receivers` green. `android-emulator (API 34)` failed: `ForcedRelayTest` over TLS ended in `storage_error`, now logged as `class=SecurityException` — MediaProvider handled the orchestrator's data clear about 15 s late and orphaned the Downloads item being received (the same cause as the 1ce5705 interop failure); fixed in the test harness (c221089, `SettledMediaRunner`). iOS Pro Max: the guest Cloud test and both relay tests passed; the signed-in Cloud test failed because the `flip` helper tapped through the consent sheet onto Approve (test fix 6aac3e3).
- c221089 (CI 43257880635): `android-emulator (API 34)` green with the new runner; Nightly `android-matrix` 29 and 35, `android-web-interop`, `clipboard-cross-client`, `turn-forced` green.
- 6aac3e3 (CI 43262617979, Nightly 43262617958): every CI job green except `ios-simulator` (signed-in Cloud test: "the receiver holds the key" timed out — a key request sent before the receiver's WebSocket connected was dropped and not retried; fixed for all clients in 981add9). Nightly iPhone 16 Pro Max: the full iOS UI suite green (21 tests, both `CloudUITests`, both `RelayUITests`); `ios-background-suspend`, `ios-web-interop`, `android-matrix` 29 and 35, `android-web-interop` green; SE and oldest lanes cancelled by GitHub (no runner).
- 981add9 (CI 43270835440): `ios-simulator` green (21 tests including both `CloudUITests` and both `RelayUITests`), `ios`, `e2e-web` green; Android jobs failed to compile (the SOCKET_OPEN branch landed in the uploader too; fixed in c405866).
- c405866 (CI [43275258671](https://github.com/Juliolayme/share_anywhere/actions/runs/43275258671), Nightly [43275288440](https://github.com/Juliolayme/share_anywhere/actions/runs/43275288440)): **every CI job (16) and every nightly job (15) green**, including `android-emulator (API 34)`, `ios-simulator`, and the whole iOS matrix (Pro Max, SE, oldest runtime, XXXL).

## Round 1 — commit 971cd8e — FAIL

0 code P0 (the P0 was the exit gate: no report, no green device lanes), 5 P1, 11 P2. Backend, Web unit and e2e (Cloud, turn-forced UDP/TLS/migration), iOS core tests passed in the agent's own runs.

P1 findings and fixes (0e60e08):

1. Production-shaped coturn config without TLS or the usage exporter → `infra/coturn/turnserver.conf` enables TLS on 5349 and `prometheus` with username labels; dev compose mounts the certificate and sets `SA_TURN_METRICS_URL`; ADR 0029 documents production 443 on its own address and the exporter's lag and growth.
2. Cloud downloads restarted at part 0 on every retry (and were charged again) → per-file part cursor and hash state on Web, Android and iOS; the same partial file is reused; TRANSFER_PROTOCOL §9 states the in-memory scope and the P2P-bytes backlog.
3. Objects not deleted when receivers finished over P2P → a transfer reported `COMPLETED` counts as that receiver's receipt (`cloudDelivered`), with a backend test for a mixed P2P and cloud session.
4. A signed-in, not-added device could consent and raise the budget → `PUT /v1/cloud/settings` is `account+device`; distribute refuses with `403 device_not_added`; settings report `device_added` and the three clients show the option disabled with the reason.
5. No green CI on the head → the loop above; see the final gate.

P2 fixed in the same commit: concurrent distribute (unique-index 500), part charged twice on concurrent uploads or store failure, estimate overflow (capped at 20 GB), paused objects not unpaused when the month turns, part request deadlines, the budget label concatenating "(GB)", the invalid-budget message (Web, iOS, Android), `product.cloud_ready` overclaiming, the Web/Android stall detector migrating during verification, API.md wording, tests for removed receivers and ended sessions.

P2 recorded as backlog (report §7): the sender has no relay-cap notice (receivers do); deletion in the S3 store is asserted through the wrapper, not a 404 Get; relay-cap behaviour against real coturn traffic at the cap.

## Round 2 — commit 1ce5705 — FAIL

Exit gate open (no report, no green iOS lanes), 3 P1, 5 P2. Most round 1 fixes verified (backend against the Versity gateway, lint, Web unit and e2e, iOS core).

P1 findings and fixes (8bfd25c):

1. iOS: a cloud download that stopped could not fall back to P2P for files over 8 blocks (the cloud sidecar had one block, the P2P bitmap check threw) → the sidecar carries `Wire.blockCount`; a `ControllerTests` case with a 9-block file (fails on the old line).
2. Web memory mode: P2P `prepare` replaced the sink holding cloud parts, and a resumed download then delivered a zero-filled head that passed the hash (the hash state covers earlier parts) → P2P reuses the memory sink; every client calls `CloudReceive.restart` whenever it starts a new sink or partial file (the same path existed on Android and iOS); Vitest cases for resume and restart.
3. The minute sweep unpaused exhausted objects every minute (`used < budget` while a refused charge leaves `used` just under) → an object is unpaused only when the remaining budget covers its next full part (sweep and budget raise); a backend test sweeps after exhaustion (stays paused) and after the month turns (unpaused).

P2 fixed in the same commit: a receipt deleted an object still uploading (now deleted at seal, and never with no receipt; backend test); no resume tests (added on Web and iOS). Also from CI: the iOS Cloud option fix above, and storage errors on Android send and log the exception class rather than a message with local paths.

P2 recorded as backlog (report §7): a claimed part whose store write never happened (crash between claim and Put) and charging before a failed Get; the earlier backlog items.

## Round 3 — commit 8bfd25c — FAIL (exit gate only)

No P0 or P1 in code or docs; all round 2 P1s verified fixed, with regression tests that fail on the old code (checked by the agent). FAIL only because the exit gate was open (iOS Cloud tests not yet green, report uncommitted).

P2 findings: report wording (metrics scraped by the `compose` job and the Playwright specs; relay credentials renewed only while relayed; resume wording; backlog ranks) — applied; a receipt racing with seal leaves a delivered object until the sweep; Android ignores neither events from a torn-down receiver connection nor serialises `SafSink` close with writes — both recorded as backlog (report §7). The agent's analysis of the interop `storage_error` (no Phase 8 cause) was confirmed by the CI diagnostics above.

Found by CI after round 3 and fixed: the Android test harness race (c221089), the iOS Cloud test tapping through consent (6aac3e3), the dropped cloud key request on all clients (981add9, Vitest case), and the uploader compile error (c405866).

## Round 4 — commit c405866 — FAIL (exit gate only)

No P0 or P1. The agent verified the cited runs, the harness change, the single-tap test fix and the key retry on all three clients (SOCKET_OPEN handled before the session filter; only a sent request starts the wait). Open items were the exit gate: green CI and nightly on c405866, and the committed report.

P2 (report §7 or applied): replace rather than merge the receiver's cloud object list after a reconnect, and drop an object on `unavailable` (backlog); report wording for the resolved Android harness issue, per-lane iOS evidence, and the metrics sentence (applied).

## Final gate

CI 43275258671 and Nightly 43275288440 on c405866 are green in every job; the report is committed with them (`docs/phases/reports/PHASE_8_REPORT.md`).
