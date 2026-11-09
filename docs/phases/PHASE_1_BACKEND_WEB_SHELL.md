# Phase 1 — Backend core, auth, devices, Web shell

Read: PRD §2 (auth, guest), §4, §5.1, §5.7, §8, §11; `docs/TESTING_AND_CI.md` §3, §4.

## Scope
- Accounts and auth: sign up, sign in, sign out, password reset via mail adapter (dev sink: console + mailpit container).
- Device registry: register, rename, revoke, list, current-device marker.
- Session cookie auth for Web with CSRF; bearer device token for Android (used by Android later; tested now via API tests).
- Rate limiting middleware for auth endpoints.
- SQL migrations and migration tooling decision (ADR 0007).
- OpenAPI contract in `shared/protocol/openapi.yaml` with generated TS client (`openapi-typescript`) and Go server types (`oapi-codegen`).
- Web shell: all five navigation routes with real layout, account menu, theme switcher (system/light/dark), language switcher EN/VI, responsive sidebar/topbar, auth pages, devices page fully functional, settings page with theme/language/account sections functional, others as honest empty states ("coming in later phase" is not allowed as copy; use a real empty state for the feature).
- WebSocket hub skeleton: authenticated connect, `Origin` check, heartbeat, `DEVICE_CONNECTED/DISCONNECTED` events visible on Devices page.

## Out of scope
Share sessions, transfers, clipboard events, Android code.

## Deliverables
- `backend/internal/{auth,devices,platform}` with handlers, services, repositories, migrations `0001_users`, `0002_auth_sessions`, `0003_devices`.
- `web/src/features/{auth,devices,settings}`, `web/src/app/` router and shell, `web/src/i18n/{en,vi}.json`.
- `docs/API.md` generated from OpenAPI; `docs/ARCHITECTURE.md` first version with request flow and auth diagrams.
- `shared/protocol/websocket-events.json` v1 with the two device events and a JSON Schema.

## Tests to add
- Backend: Argon2id hashing params test; sign-up/sign-in/sign-out integration; CSRF rejection; rate limit lockout; device revoke invalidates its token; authorization table tests (foreign user → 404).
- Web: Vitest for auth forms validation and i18n catalogs having identical key sets; Testing Library for theme switcher.
- Playwright (all 5 projects): sign up → land on Transfer home → register device name → see it in Devices → rename → sign out → sign in. Mobile projects additionally assert the compact navigation and that touch targets are ≥ 44 px (computed box).

## CI changes
`e2e-web` job added with the five-project matrix and `docker-compose.ci.yml`. `protocol` job validates OpenAPI and checks generated clients are current.

## Exit gate
All `ci.yml` jobs green; Playwright suite green on all five projects; backend coverage ≥ 70 % for `auth` and `devices`; `docs/API.md` matches `openapi.yaml`.

## Report
Per `CLAUDE.md` §9, listing per browser project which flows ran.
