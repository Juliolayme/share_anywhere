# Phase 9 report: hardening and release readiness (final report)

Status: see §4 for the CI runs that close the exit gate. This report also consolidates, per platform, what the whole project has implemented and tested versus what is untested (§1.5); the detail of each feature is in the earlier phase reports, and every open limitation is in `KNOWN_LIMITATIONS.md`.

Every "tested" claim was executed in GitHub Actions (Ubuntu runners for the backend, Web and the Android emulator; the macOS 15 runner with Xcode 16.4 and iOS 18.x simulators for iOS) or in the cloud development container (Linux: Go against PostgreSQL 16, the Compose CI stack, Playwright Chromium and stock Firefox, Swift 6 on Linux). **Nothing ran on a real phone, a real iOS Safari, or across real networks.**

## 1. What was implemented

### 1.1 Security review (implemented and tested)

- **Review against `docs/SECURITY_MODEL.md`** (`docs/qa/PHASE_9_SECURITY_REVIEW.md`): every abuse case in §7 and every control in §9 mapped to automated evidence, with what remains manual. Findings: an off-by-one in the failed-lookup lockouts (11 failures per address instead of 10, 6 per device instead of 5; fixed with an exact check in `sharing.failedLookup`), concurrent lookups passing the lockout check together (QA round 1; lookups are now serialized per address and per device, `TestConcurrentLookupsStopAtTheAllowance`; the ceiling is 10 in a row and at most 15 in the first hour as the bucket refills during the lockout), the CGNAT residual risk (accepted, ADR 0031), an unreachable advisory in an indirect Go module, and a flaky WebSocket test (fixed).
- **IDOR and access-level sweep** (`backend/cmd/server/idor_test.go`, `TestIDORSweep`): the whole server on a fresh schema; a guest stranger, a receiver, and a signed-in stranger with an added device (so Cloud's sender routes are refused by ownership, not by the account gate) get 403 or 404, never a validation or state error, on every member-only, sender-only and other-account route with a resource id (sessions, participants, transfers, files, Cloud objects, TURN on someone else's session); nothing changes; members and the sender still succeed. The guest-token-against-`account`/`account+device` sweep is `TestAccountLevelsFromOpenAPI` (from Phase 5A, re-run).
- **Abuse soak** (`backend/cmd/server/soak_test.go`, `TestAbuseSoak`, nightly `abuse-soak` at 5× scale): an in-process load generator at production limits with a fake clock. Sybil creation (3 free identities per address, 7 more with proof of work, then refused); CGNAT (one address: 3 identities, 30 sessions per hour); distributed code guessing until protected mode trips (exactly at 300 failed lookups per minute; code joins then require approval; 20 of 20 link joins still succeed); a slow attack at 290 a minute (2,900 guesses in one join window, 0.29 % hit chance per live session, without tripping); a lone address (10 failures in a row, then locked out); legitimate guests from distinct addresses succeed throughout. `CODE_GUESS_ALARM_PER_MIN` stays 300 (ADR 0031).
- Token lifetimes, WebSocket origin and tickets, CSP (already enforced, not report-only), dependency and image scanning, and a gitleaks pass over the full history (211 commits, no leaks) re-checked.

### 1.2 Accessibility and responsive pass

- **Web, implemented and tested:** axe-core (`@axe-core/playwright` 4.14.0) in Playwright, failing on serious and critical violations, CI job `a11y` in all five projects: every guest route in light and dark; a full transfer (session, preview, save, progress, result, dashboard, history and its detail drawer, a share link); the receiver states (waiting for approval, joined, removed, blocked, session ended) and the sender's Block and Close confirmations; every account step (create account, add device, recovery phrase, checklist), pairing a second browser, the signed-in tabs, the clipboard paste form and detail drawer. A keyboard-only spec (skip link first, send and receive a file without a pointer, visible focus, Settings switches and theme, focus at the new screen after Welcome) in desktop Chromium and Firefox. Fixes: the language button's name; link, subtitle, recovery-number and clipboard-note contrast; links in text underlined; a scrollable dashboard table reachable by keyboard; focus no longer jumping to `main` on the page's first screen but moving there after Welcome and sign-in.
- **Visual snapshots:** the six main screens × English and Vietnamese × light and dark in all five projects (nightly `visual-snapshots` generates, `visual` compares at 1 % tolerance and fails when a project has no baselines). Per-run device names get a fixed text before capture, and the theme is set through the app's preference and asserted (QA round 2 found the Firefox `dark` captures were light; see §4 for the regenerated baselines).
- **Android:** `accessibilityProblems` (TestSupport) audits every clickable node in every window for a spoken name and a 48 dp touch target, each control scrolled into view first (the automated part of an Accessibility Scanner pass): the main tabs, Send and Receive in `AccessibilitySemanticsTest`, and the session (with a receiver, a request, expired, the Block dialog, ended), dashboard, preview, save and result screens inside `SenderSessionTest` and `TransferTest`. It found two 40 dp buttons (Stop accepting, Devices Create account), fixed.
- **iOS:** `performAccessibilityAudit()` (iOS 17+ simulators) on the main tabs in `AccessibilityAuditUITests` and inside `TransferUITests` (session with a receiver, a request, expired; dashboard; preview, save, progress, result) and `AccountUITests` (sign-up, add device, key setup, checklist, pairing). It found real defects, fixed: type that did not follow Dynamic Type (fixed `.system(size:)` fonts → text styles, `Theme.swift`), `fg-3` small text under 4.5:1 (tokens allow `fg-3` for large text only) and other near-miss colours, Welcome overflowing at large sizes, a 6 pt progress bar exposed as a control. What fails the test: element descriptions, hit regions, traits, Dynamic Type "unsupported" and clipping, minus stated exclusions in `Support.swift` (`-uiTesting` probes, single file names for the readable-label check, clipping inside navigation bars, Form/List cells, which covers our own History and Settings rows, and system search fields). Contrast reports and "partially unsupported" Dynamic Type are attached to the result as notes instead: in repeated CI runs the pixel-sampled contrast check reported AA token pairs (navy on white, 13:1) as failing, and the partial report moved between screens from run to run; the declared token colour pairs are verified by `scripts/tokens.test.mjs` and by axe on the Web. Pairs composited at run time are not covered: `Chip` tints (`color.opacity(0.12)` over whatever is behind, e.g. the participant status and clipboard "New" chips) pass today, the lowest at 4.59:1 over `surface`, but the same chip on `surface-2` would fall to about 4.1:1 unnoticed; they are part of the Accessibility Inspector review (backlog). Issues the audit attributes to no element are notes too. A timed-out audit is retried. On the iPhone SE nightly lane the partial reports cluster on Sign in; that is recorded for review (§7). Design deviations: `docs/design/DESIGN_DEVIATIONS.md` §P.
- **Untested:** TalkBack and VoiceOver walkthroughs by a person; Accessibility Inspector review; contrast on real displays (real-device checklists).

### 1.3 Lifecycle and failure injection

- **Android, implemented and tested on the emulator (API 29 and 35, Nightly 43297156045):** process death during a receive resumes at the next start from the persisted block map (`IncomingDao.unfinishedSessions`, `TransferRuntime.resumeUnfinished` after identity is ready); `ProcessDeathRestoreTest` (192 MB, the controller released mid-transfer) asserts resumed bytes > 0, no block verified twice, and a matching SHA-256. At start the sweep runs first (deleting the half-written documents of receives older than a day), only receives touched in the last day resume, and a receive whose transfers all ended while the process was dead is cleaned up instead of left as a partial file. Storage full and a revoked source are engine tests (`EngineTest.kt`: `FullDisk`, `RevokedSource`).
- **iOS, implemented; simulator results in §4:** unfinished receives are recorded (`transfers/pending-receives.json`), marked suspended before the pause goes out (an app ended right after it keeps the mark), and resumed once the identity is ready (also after Retry); entries are dropped on release and forgotten when the device identity changes; `TransferUITests` terminates the suspended app, relaunches it and checks the receive resumes, and cold-starts the app from a share link into the join preview. Storage full and an invalidated security-scoped bookmark are engine tests (`EngineTests.swift`: `FullDisk`, `RevokedSource`; 19 engine tests pass on Linux).
- **Web:** the same storage-full and unreadable-source cases in `engine.test.ts`.
- **Failure injection, tested (nightly `chaos`, all four passed locally and in Nightly 43297156045):** a backend restart mid-transfer (the transfer completes peer to peer and reports catch up), the database unreachable for 8 s and then every connection dropped (a receiver joins afterwards), coturn stopped (a direct transfer completes), the edge proxy restarting (WebSockets flap; the sender sees a later receiver).

### 1.4 Performance and release

- **Throughput benchmark** (nightly `throughput`): 256 MiB per route and engine on loopback in CI: direct 13.8 (Chromium), 18.8 (Firefox), 17.2 MiB/s (WebKit); relay over UDP 14.7 and over TLS 14.3 MiB/s (Chromium). Table and the memory ceilings of each client in `docs/PERFORMANCE.md`.
- **Deployment:** `docker-compose.prod.yml` (every secret required, PostgreSQL unpublished, coturn on the host network with its relay range, Caddy with automatic HTTPS from `infra/caddy/Caddyfile.prod`) validated with `docker compose config` and `caddy validate`; the backend accepted the production environment. Runbooks: `docs/runbooks/deploy.md`, `backup-restore.md` (dump and restore verified on the CI stack, row counts matched), `incident-basics.md`.
- **Release:** `docs/RELEASE_CHECKLIST.md` (CI gates, Android signing without keys and Play policy for the `dataSync` foreground service, clipboard and data safety, iOS signing and TestFlight without certificates, App Review for background behaviour, clipboard, files, the privacy manifest and export compliance); iOS `PrivacyInfo.xcprivacy` (checked in the built bundle by `ios-simulator`); `KNOWN_LIMITATIONS.md`; README with CI screenshots.
- **Release blockers found:** account deletion is not built on any platform (no endpoint, no screen in the design handoff), and both stores require it for apps with sign-up; open-source notices (design F7, Settings → Licenses) are not shown, and binary distribution needs them. Phase 9 excludes new features, so both are recorded as blockers in the checklist and the limitations page, as open decisions in the PRD and the phases README, and as P0 for the release in §7.

### 1.5 Consolidated status per platform (all phases)

"Tested" means implemented and executed on that platform's target (Playwright project, emulator or simulator); **partial** marks scoped parts that are missing; **untested** and **not built** are marked as such. The evidence for each row is in that feature's phase report.

| Area | Web | Android | iOS | Backend |
|---|---|---|---|---|
| Guest identity, guest-first onboarding | Tested (5 projects) | Tested (emulator) | Tested (simulator) | Tested |
| Sessions: code, link, QR, open join, approval, Remove, Block, 10-min window, new code | Tested | Tested (QR scan by camera untested) | Tested (camera untested) | Tested |
| P2P transfer, verification, pause/resume, receiver reload or reconnect | Tested (2 GB nightly); **partial:** no Retry for one failed receiver, Open, Show in folder or Send again (G3, G4, G12, G16) | Tested (192 MB) | Tested (64 MB interop) | Records tested |
| Five receivers, fair scheduler | Tested (nightly) | Engine tests | Engine tests | Cap tested under concurrency |
| Relay (TURN UDP/TLS), route migration | Tested on loopback (Chromium) | Tested on loopback | Tested on loopback | Credentials, cap tested |
| Cloud Distribution | Tested (Chromium) | **UI untested** (unit tests only) | Tested (simulator) | Tested with an S3 gateway |
| Keep screen on | Tested | Tested | Tested | — |
| Background behaviour | Tab suspension untested on iOS Safari | Foreground service tested; Doze, OEM savers untested | Suspension tested in the simulator; real timing untested | — |
| Lifecycle (process death / termination) | Receiver reload tested | Tested | Simulator results in §4 | — |
| Accounts, devices, keys, history sync | Tested | Tested | Tested; **partial:** no change password or two-step verification (deviation N) | Tested |
| Clipboard Sync (E2E) | Tested (manual Sync, capture in Chromium) | Tested (foreground capture) | Tested (fallback read; Paste control untested) | Tested |
| Accessibility | axe + keyboard tested | Semantics audit; TalkBack untested | Audit; VoiceOver untested | — |
| Account deletion | **Not built** | **Not built** | **Not built** | **Not built** |
| Open-source notices (Licenses) | **Not built** | **Not built** | **Not built** | — |

## 2. Usable screens and routes

No new screens. Every screen listed in the Phase 1–8 reports is usable on Web, Android and iOS as reported there. New operational surfaces: `docker-compose.prod.yml`, `infra/caddy/Caddyfile.prod`, the nightly jobs `abuse-soak`, `chaos`, `visual-snapshots`, `visual`, `throughput`, and the CI job `a11y`.

## 3. End-to-end workflows executed

- **Guest, Web (five Playwright projects, CI `a11y`):** every guest route under axe in light and dark; a transfer from session to dashboard, history detail and a share link under axe; the receiver states and sender dialogs under axe; send and receive by keyboard alone, and Welcome → Transfer home with focus on the new screen (desktop Chromium, Firefox).
- **Signed in, Web:** create account, add device, recovery phrase, checklist, pairing a second browser by code, the signed-in tabs, a clipboard item synced through the paste form and its detail drawer, all under axe.
- **Guest, Web, failure injection (Chromium, Compose stack, nightly `chaos`):** backend restart mid-transfer, database outage, coturn down and proxy restart around live sessions.
- **Guest, Android emulator (API 34 in CI, 29 and 35 nightly):** receive interrupted by releasing the controller (process death) and resumed at the next start, verified; the session, dashboard, preview, save and result screens audited inside the transfer and session tests.
- **Guest, iOS Simulator (iPhone 16, iOS 18.x):** receive interrupted by terminating the suspended app and resumed at the next launch; cold start from a share link into the join preview; signed in: sign-up, key setup, pairing; each screen audited.
- **Backend:** IDOR sweep (guest stranger, receiver, signed-in stranger) and abuse soak against PostgreSQL 16 locally and in the nightly.

## 4. Commands and results

Local (cloud development container):

- `cd backend && gofmt -l . && go vet ./... && golangci-lint run ./...` (v2.15.0 built with go1.27.4): clean, 0 issues. `TEST_DATABASE_URL=… go test -count=1 ./...`: all packages pass, including `TestIDORSweep`, `TestAbuseSoak`, `TestConcurrentLookupsStopAtTheAllowance` (also 20 runs under `-race`; it fails when the lookup gate is removed).
- `cd web && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`: clean, 495 tests. `pnpm lint:md`: 0 issues.
- Against the Compose CI stack in Chromium: `E2E_A11Y=1` axe (5 tests) and keyboard (3) specs pass; `E2E_CHAOS=1` (4), `E2E_VISUAL=1`, `E2E_BENCH=1` (Chromium and stock Firefox) passed during the phase.
- `cd ios/ShareAnywhereCore && swift test` (Linux, Swift 6): 110 tests, 0 failures; SwiftFormat lint and SwiftLint strict clean. The app and UI-test targets (SwiftUI, XCTest UI) build only in CI on macOS.
- ktlint on all Kotlin: clean. The Android app and instrumentation tests build only in CI.
- `docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q` with a sample env: valid (metrics on 127.0.0.1:9090); without secrets: refused. `caddy validate` on `Caddyfile.prod`: valid. Backup and restore round trip: row counts matched.

CI and nightly (GitHub Actions) — the run history of the QA loop is in `docs/qa/PHASE_9_QA.md`. Final runs:

FINAL_RUNS_PLACEHOLDER

## 5. Environment variables and external services

- Production: the variables in `docs/runbooks/deploy.md` §3 (`SA_DOMAIN`, `SA_ACME_EMAIL`, `POSTGRES_PASSWORD`, `SA_TOKEN_KEYS`, `SA_TOKEN_ACTIVE_KID`, `SA_SERVER_SECRET`, `TURN_SHARED_SECRET`, `SA_TURN_HOST`, `SA_TURN_EXTERNAL_IP`, `SA_TURN_CERT_DIR`, `SA_SMTP_*`, `SA_MAIL_FROM`; optional App Links, Cloud). Full list: `.env.example`.
- Test switches: `E2E_A11Y`, `E2E_CHAOS` (with `E2E_COMPOSE`), `E2E_VISUAL`, `E2E_BENCH` (with `E2E_BENCH_OUT`), `SOAK_SCALE`, `SOAK_REPORT`.
- External services for a release: a VM with a public IP and DNS, a TLS certificate for the TURN host, an SMTP relay, optionally an S3-compatible store; Google Play and Apple Developer accounts with signing keys held outside the repository.

## 6. Known limitations and untested behaviours

Consolidated in `KNOWN_LIMITATIONS.md`. The most important:

- No real devices, no real networks, no real Safari on iOS: every platform claim is emulator, simulator or Playwright emulation. TalkBack and VoiceOver walkthroughs by a person are not done.
- Store submission is blocked by two items not built: account deletion and open-source notices (open decisions in the PRD).
- Open join's residual guessing risk under the alarm rate, and per-address limits shared behind CGNAT (ADR 0031).
- No production deployment has been made; the production Compose file and Caddyfile are validated statically and by a backend start. IPv6 clients are not supported with this Compose layout.
- The iOS accessibility audit does not fail on contrast or on "partially unsupported" Dynamic Type (kept as notes on the result, reasons in `ios/Tests/ShareAnywhereUITests/Support.swift`); colour contrast on iOS rests on the token check and Web axe, not on a native measurement. It also skips test-only probes, single file names for the label check, clipping in system search fields and system-styled controls, and issues without an element (notes).
- Android Cloud UI is untested; Firefox relay is untested (loopback TURN is ignored by Firefox).
- Intermittent tests seen during the phase, outside Phase 9 code:
  - an emulator boot with a 16 MB heap limit (API 29, once);
  - `ClipboardEngineTests.testRemoveAndClearReachEveryDevice` (iOS core, once locally in about 70 runs);
  - `ControllerTests.testADroppedConnectionResumesWithoutResendingVerifiedBlocks` (iOS core, runs in the required `ios` job; QA saw it fail once in 18 local runs): the receiver's reporter still held RECONNECTING when the server already had TRANSFERRING, so its RESUMING report got a 409 and the walk stopped (Phase 7/8 code, `Reporter.swift`);
  - an XCUITest "no keyboard focus" typing failure (Pro Max, once; the helper now waits for focus);
  - `TestPresenceOrderAcrossSockets` (backend, CI 23a30eb, once): the test read a device's final presence while later events were still queued; it now waits for empty queues and a stable state (30 runs under `-race` locally);
  - test timing, fixed in the tests: on the oldest-runtime and SE lanes the receive resumed after the relaunch finished before the banner's Open could be tapped (the result is now read from app-level probes and the test no longer taps the banner); in `ios-web-interop` the first native test spent eight minutes installing while the Web sender waited five (warm-up first, cdb557a); a cold simulator took more than 10 s to show the Receive screen (`ios-background-suspend`, wait raised to 30 s);
  - an iOS stall of about 60 s after Add this device, twice. On Nightly 43332023625 (`ios-web-interop` clipboard half) the app stalled about 67 s inside adding the device while the backend answered in 3 ms. On the iPhone SE lane of Nightly 43338202850 (507ca64, `AccountUITests` pairing test), after `POST /v1/devices/current/add` and `GET /v1/me` the app sent nothing for 57 s, then `GET /v1/keys`, and the pairing code appeared just after the test's 60 s wait (the printed UI tree shows it). The time is spent on the device before the key check's first request (key vault, Keychain or the check's queue); the cause is not found yet.
- The iOS matrix nightly lanes (iPhone SE, Pro Max, oldest runtime) failed on audit findings on every Phase 9 nightly until a4a5693/507ca64, each round fixing real defects (§1.2). On the SE lane the resumed 256 MiB receive took more than 300 s after the relaunch, against about 43 s for the whole test on iPhone 16 on the same runner type; the wait was raised to 600 s and the gap is unexplained (backlog).
- History reports Dynamic Type and clipping issues that name no element on every iOS run (kept as notes); the element is still to be identified.

## 7. Backlog

- **P0 (release):** account deletion on all platforms (product decision on scope and grace period, design, endpoint, UI, tests); open-source notices (Licenses screen, generated notices per platform); run the real-device checklists (Android, iOS) and record the results; a staging deployment on a real domain with TURN over TLS.
- **P1:** TalkBack and VoiceOver walkthroughs; review the iOS audit notes (contrast, partial Dynamic Type; the iPhone SE Sign in cluster) with the Accessibility Inspector on a device; legal confirmation of the export-compliance answer; an Android emulator test for a Cloud transfer; a boot check in the Android emulator workflow (heap growth limit) so a bad emulator reports as infrastructure.
- **P1:** the iOS stall of about 60 s between Add this device and the key check (twice on loaded simulators, never on the required `ios-simulator` job in its last runs; real devices untested): find where the time goes with signposts on a device, then fix. Identify the History Dynamic Type and clipping issues the iOS audit reports without an element on every run (they repeat, so they are not noise; start with the chip `ScrollView` inside a List row).
- **P2:** the `ClipboardEngineTests` and `ControllerTests` resume-report intermittents (for the latter, re-read the server state on a 409 and walk again); the slow resume on the iPhone SE lane; the audit helper's cell and navigation-bar skip matches by label when an element has no identifier (match by frame instead); note a retried sign-out tap in the UI-test result so a first tap that does nothing would show; declare the chip tint pairs in the token check; axe dark passes for the flows (guest routes only today); a context-aware lookup gate so cancelled requests leave the queue; items carried from the Phase 3–8 reports (Web Retry for one failed receiver, per-file re-download, cloud resume across restarts, coturn exporter series growth).

## 8. Local run

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

The Web app is at <https://localhost:8443>. For a production-like run see `docs/runbooks/deploy.md`; the nightly suites run against `docker compose -f docker-compose.ci.yml up -d --build --wait` with the switches in §5.

## 9. Commits

| Commit | What |
|---|---|
| 23c302a | IDOR sweep, abuse soak, exact failed-lookup lockouts |
| f0feb81 | Security review against the threat model |
| 3be5aaa | Accessibility: axe and keyboard on the Web, audits on Android and iOS |
| 83aa021 | Chaos and visual nightly passes |
| 49f8c33 | Resume unfinished receives after process death or termination (Android, iOS); lifecycle engine tests |
| 668a636 | Runbooks, release checklist, known limitations, performance, production Compose, privacy manifest, README |
| 11ae428 | Android a11y audit leaves Send with Back |
| cc80699 | iOS Dynamic Type fonts and AA text contrast; audits on transfer screens; CI throughput numbers |
| 504b8b1 | axe on every account step and receiver state; 48 dp targets; runbook and checklist corrections |
| 6ef3ad7 | Exact lockouts under concurrency, strict IDOR sweep, safer resume on launch |
| e2cac2b | Web focus after Welcome |
| 34738ed | Visual baselines for five projects; a missing baseline fails |
| 590a0bb | iOS audit round 2, suspended flag before pause, cold-start test configuration |
| eaa2631 | QA round 2: Firefox dark captures, test-fake channel open, stale partial files |
| cbe8ca8 | Interop teardown time |
| 5dd0430, cecfd8e | iOS unit-test configuration, audit recheck and retry |
| 4e1ee94 | Audit helper availability, regenerated baselines, dark axe pass asserts the theme |
| cb6c8f2 | iOS small-screen audit findings (targets, Welcome scroll, labels, large-type layouts) |
| a4a5693 | iOS audit: contrast and partial Dynamic Type as notes |
| 507ca64 | iOS 44 pt targets on button labels; longer SE resume wait |
| f8a9beb | QA round 3: recovery words grid, sign-out tap, audit classes, report drafts |
| 0f81557 | QA round 4 docs; the merged banner's Open found by label |
| cdb557a | `ios-web-interop`: simulator warm-up before the Web sender's join window; 9-minute Web wait |
| b2a79b2 | Resumed-receive result checked through app-level probes (`test.last-rx-*`); cold-start wait |
| 23a30eb | Spinners next to a status text hidden from accessibility (the audit caught the identity spinner on Home) |
