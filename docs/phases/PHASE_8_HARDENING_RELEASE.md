# Phase 8 — Hardening and release readiness

Read: PRD §10, §11, §12, §13; `docs/TESTING_AND_CI.md`.

## Scope
- Security review against `docs/SECURITY_MODEL.md`: IDOR sweep, token lifetimes, WS origin, CSP report-only → enforce, dependency and image scanning results triaged, secrets scanning history check.
- Accessibility pass: axe-core in Playwright for every route and project, keyboard-only walkthrough spec, TalkBack review on emulator with Accessibility Scanner.
- Responsive and browser pass: visual snapshots for all five projects, light/dark, EN/VI.
- Android lifecycle pass: process death during transfer restores from bitmap; permission revoked mid-transfer; storage full.
- Failure injection: backend restarts mid-session, postgres restart, coturn down → graceful fallback messaging, WS flaps.
- Performance: throughput benchmark table per route and engine from nightly artifacts; memory ceilings documented.
- Deployment: `docs/runbooks/deploy.md` (Compose on a single VM, Caddy HTTPS, coturn ports, env vars), `backup-restore.md`, `incident-basics.md`; release checklist; Android signing documented without keys; Play policy checklist for foreground service and clipboard; known limitations page consolidated from PRD §6.8 and §7.
- README with screenshots from CI artifacts.

## Out of scope
New features.

## Tests to add
- Playwright a11y job (axe) across projects, failing on serious/critical.
- Chaos specs listed above under `e2e-web` nightly.
- Android instrumentation: process-death restore.

## CI changes
`a11y` job added to `ci.yml` and required; nightly chaos jobs.

## Exit gate
All required checks green; release checklist complete; `KNOWN_LIMITATIONS.md` published; final report consolidates implemented/tested vs untested per platform.
