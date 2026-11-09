# Phase 1 — Backend core, anonymous device identity, guest-first Web shell

Read: `CLAUDE.md` §7, §8b; PRD §2 (guest-first, device identity, history, abuse controls), §4, §5.1, §5.6, §5.7, §5.8, §8.1, §8.4, §8.5, §11.2; `docs/TESTING_AND_CI.md` §3, §4.

No accounts in this phase. Everything built here must work for a user who never signs in, because that is the default user.

## Scope
- `backend/internal/platform`: config validation, PostgreSQL pool, migrations (tool chosen in ADR 0007), HTTP server, structured logging with redaction (tokens, IPs hashed per PRD §12), access-level middleware driven by the OpenAPI `x-sa-access` extension, rate-limiter middleware (in-memory token buckets keyed by IP /64 and device, injectable clock), trusted-proxy handling for `X-Forwarded-For`, WebSocket hub with one-time tickets, `Origin` check, heartbeat.
- `backend/internal/devices`: anonymous device bootstrap, proof-of-work challenge above the IP soft limit, Ed25519-signed access tokens (EdDSA only, `kid` rotation from config), refresh secret rotation with reuse detection, `GET|PATCH /v1/devices/current`, `POST /v1/devices/current/reset`, inactive-device purge job. ADR 0008 records the token format and lifetimes.
- Migration `0001_devices`.
- OpenAPI in `shared/protocol/openapi.yaml` with `x-sa-access` on every operation, generated TS client (`openapi-typescript`), Go server types (`oapi-codegen`).
- Web shell, guest-first:
  - First visit: `/welcome` with one primary action **Get started** → Transfer home. Anonymous identity is created in the background; failure shows an inline retry on Transfer home without blocking navigation.
  - Navigation: Transfer, History, Devices, Settings. The Clipboard tab is hidden behind the `clipboard` flag (`CLAUDE.md` §8b).
  - Transfer home with Send and Receive actions. Session creation and joining arrive in Phase 2, so in this phase Send opens the real file picker and review screen and Receive opens the real code-entry screen with validation; the Create session and Join buttons stay hidden behind a `sharing` flag until Phase 2 turns it on.
  - History backed by a real IndexedDB store (`web/src/features/history/store`) with an empty state and a "Stored on this device only" banner (without the Sign in action while `accounts` is off).
  - Devices shows the "This device" card with rename and reset identity.
  - Settings shows the "Guest" identity header (no Sign in button while `accounts` is off), device name, theme system/light/dark, language EN/VI, local history retention and Clear history, privacy, about.
  - Access token in memory; refresh via the `sa_device` cookie and `X-SA-Refresh` header; silent refresh before expiry; 429 handling with `Retry-After` messaging.
- `docs/ARCHITECTURE.md` first version (request flow, identity and token flow diagram, rate-limit placement); `docs/SECURITY_MODEL.md` first version with the anonymous-use rows of PRD §11.2 that apply to this phase; `docs/API.md` generated from OpenAPI with the access-level column.

## Out of scope
Accounts, sign-in screens, share sessions, transfers, clipboard, Android, iOS.

## Tests to add
- Backend: token signing and verification (wrong `alg`, wrong `kid`, expired, tampered claims all rejected); refresh rotation; reuse of an old refresh secret revokes the device; device creation rate limit returns 429 with `Retry-After`; proof-of-work required above the soft limit and verified; `X-Forwarded-For` ignored from untrusted peers; WebSocket rejects missing/reused/expired tickets and wrong `Origin`; route table test asserting every registered route matches its `x-sa-access` level; purge job removes devices inactive past 30 days.
- Web unit: token refresh scheduler, IndexedDB history store (add, list, delete, clear, retention sweep), i18n catalogs have identical keys, feature flag gating hides the Clipboard tab and Sign in buttons.
- Playwright (all 5 projects), all as guest: first visit shows Welcome → Get started → Transfer home with no sign-in screen anywhere; reload keeps the same device ID; rename device in Devices and see it in Settings; Settings shows "Guest"; theme and language switches persist; reset identity yields a new device ID; simulated 429 shows the wait message. Mobile projects additionally assert compact navigation and touch targets ≥ 44 px.

## CI changes
`e2e-web` job added with the five-project matrix and `docker-compose.ci.yml`. `protocol` job validates OpenAPI, checks every operation has `x-sa-access`, and checks generated clients are current.

## Exit gate
All `ci.yml` jobs green; the guest Playwright suite green on all five projects; backend coverage ≥ 70 % for `devices` and the platform middleware; `docs/API.md` matches `openapi.yaml`; no account code or sign-in UI exists yet.

## Report
Per `CLAUDE.md` §9, listing per browser project which guest flows ran.
