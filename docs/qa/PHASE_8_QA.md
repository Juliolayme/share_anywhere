# QA — Phase 8 (route strategy, TURN fallback, Cloud Distribution)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs. Android and the iOS app targets build only in CI (no Android SDK or Xcode in the development container); the agent marks those items "not verified" until a CI run on the reviewed commit is green.

## CI history of the QA loop

- bea6095 to cc4e173: Web route engine and turn-forced, relay cap and metrics, Android route port. Nightly `turn-forced` green on bea6095, 4ff9796, cc4e173; CI runs superseded (cancelled) by the next push.
- a666755 (iOS route port): every job green except `e2e-web (firefox-desktop)`: `p2p.spec.ts:249` (the sender drops off) never resumed. The receiver diagnostics showed two "losses" (a channel error, then an open timeout while the sender was away) escalating to relay-only, and Firefox ignores loopback TURN (ice-error 701), so relay-only dials never connected. Fixed in e952331 (only open channels count as losses; two unopened dials on a stricter step return to the start step); verified locally with stock Firefox (p2p 7/7).
- 683b770: `security` failed (gitleaks on the published cloud vectors and a placeholder secret in a config test; allowlisted and rewritten in e5c1ecf); `protocol` failed (stale backend `types.gen.go`; regenerated in ca0e4cf); `android` failed (`GeneratedSourcesTest`: the parts path listed PUT before GET; reordered in 56848eb).
- ca0e4cf: `backend` (Cloud tests against the Versity S3 gateway), `protocol`, `security`, `compose` green.
- 9674369: `web`, `e2e-web` chromium (Cloud spec included), `android`, `ios`, `backend`, `compose`, `security` green; superseded before the device lanes finished.
- ffd47b2: `backend`, `web`, `compose`, `e2e-web` chromium and android-chrome, and `android` (Android Cloud code compiled, `CloudVectorsTest` green) green; device lanes pending at the time of writing.

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
