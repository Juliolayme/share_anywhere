# Phase 9 — Hardening and release readiness

Read: PRD §10, §11, §12, §13; `docs/SECURITY_MODEL.md` (all); `docs/API.md` §1; `docs/TESTING_AND_CI.md`.

## Scope
- Security review against `docs/SECURITY_MODEL.md`, including every abuse case in its threat model and the open-join residual risk in §3.2: IDOR sweep, access-level sweep (guest token against every `account`/`account+device` route), rate-limit soak test with a Go load generator (CGNAT-like shared IP with many devices, Sybil device creation, distributed code guessing against open-join sessions with measurement of hit rate before protected mode trips, and tuning of `CODE_GUESS_ALARM_PER_MIN`), keep-screen-on battery review (lock never held after transfers end, across all three clients), token lifetimes, WS origin, CSP report-only → enforce, dependency and image scanning results triaged, secrets scanning history check.
- Accessibility pass: axe-core in Playwright for every route and project, keyboard-only walkthrough spec, TalkBack review on emulator with Accessibility Scanner; VoiceOver audit on simulator with the Accessibility Inspector and an XCUITest `performAccessibilityAudit()` pass per screen.
- Responsive and browser pass: visual snapshots for all five projects, light/dark, EN/VI.
- Android lifecycle pass: process death during transfer restores from bitmap; permission revoked mid-transfer; storage full.
- iOS lifecycle pass: termination while suspended restores from bitmap; security-scoped bookmark invalidated; storage full; Universal Link cold start into a join.
- Failure injection: backend restarts mid-session, postgres restart, coturn down → graceful fallback messaging, WS flaps.
- Performance: throughput benchmark table per route and engine from nightly artifacts; memory ceilings documented.
- Deployment: `docs/runbooks/deploy.md` (Compose on a single VM, Caddy HTTPS, coturn ports, env vars), `backup-restore.md`, `incident-basics.md`; release checklist; Android signing documented without keys; Play policy checklist for foreground service and clipboard; iOS signing, provisioning, and TestFlight documented without certificates; App Review checklist for background modes, clipboard access, and file handling; known limitations page consolidated from PRD §6.8 and §7.
- README with screenshots from CI artifacts.

## Out of scope
New features.

## Tests to add
- Playwright a11y job (axe) across projects, failing on serious/critical.
- Chaos specs listed above under `e2e-web` nightly.
- Abuse soak job (nightly): asserts limits hold and legitimate guest flows from distinct IPs still succeed during the soak.
- Android instrumentation: process-death restore.
- iOS XCUITest: terminate-while-suspended restore; `performAccessibilityAudit()` on every screen.

## CI changes
`a11y` job added to `ci.yml` and required; nightly chaos jobs.

## Exit gate
All required checks green; release checklist complete; `KNOWN_LIMITATIONS.md` published; final report consolidates implemented/tested vs untested per platform.
