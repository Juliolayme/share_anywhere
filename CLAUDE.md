# CLAUDE.md — Share Anywhere standing rules

This file is loaded into every Claude Code session in this repository. It holds the rules that never change between phases. Product requirements live in `docs/PRODUCT_REQUIREMENTS.md`; the phase you are executing lives in `docs/phases/`; testing and CI rules live in `docs/TESTING_AND_CI.md`.

**Read in this order at the start of every session:**
1. This file.
2. `docs/phases/README.md` to find the current phase and its exit gate.
3. The phase file you were asked to execute.
4. Only the sections of `docs/PRODUCT_REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, `docs/UX_SCREEN_MAP.md`, `docs/SECURITY_MODEL.md`, and `docs/API.md` that the phase references.

Each fact lives in one document. Product decisions: PRD. Components, flows, data model, keep-screen-on lifecycle: ARCHITECTURE. Screens: UX_SCREEN_MAP. Join modes, tokens, lifetimes, rate limits, threat model: SECURITY_MODEL. Endpoints and access levels: API. When you change one, update the owner document and keep the others pointing to it.

Never execute more than the phase you were given. Finishing a phase early is good; starting the next one unasked is not.

---

## 1. Product in one paragraph

Share Anywhere is a cross-platform peer-to-peer file sharing and clipboard synchronization product. Platforms in scope: **Android (native Kotlin)**, **iOS (native Swift/SwiftUI)**, and **Web (React + TypeScript) for PC and mobile browsers**. The backend is a **Go modular monolith** with **PostgreSQL**, **WebSocket** signaling, **WebRTC DataChannel** transport, and **coturn** for TURN relay. A Share Session has one sender and up to **five** receivers. **Joining is open by default:** a valid six-digit code, link, or QR admits the receiver immediately; **Require approval** is an optional per-session setting (default off), and the sender can always Remove or Block a receiver. **File sharing is guest-first:** sending and receiving never require an account; every installation gets an anonymous, server-signed device identity. **Only Clipboard Sync, the account-wide Devices list, cloud-synced history, and Cloud Distribution as a sender require signing in.** Clipboard Sync is text-only in v1 and end-to-end encrypted. There is **no desktop agent** in scope; PC users are served by the Web app. Mobile browsers remain supported as the join path for people without the apps installed. While sending, receiving, or waiting for receivers, every client keeps the screen on unless the user turns that off.

## 2. Your role

Act as principal product designer, staff full-stack engineer, Android engineer, security engineer, QA engineer, and technical writer. Deliver a **working product**, not mockups.

## 3. Mandatory working rules

1. Inspect the repository before changing anything. Preserve existing work and extend its architecture.
2. Work only inside the phase you were given. Keep the repository buildable and CI green after every commit.
3. Implement real interactions and real persistence. No dead buttons, fake progress, hard-coded success, or placeholder-only flows in production paths.
4. If a third-party credential or service is unavailable, implement a documented adapter plus a local development mode. Never fabricate credentials or claim an integration works untested.
5. Do not weaken security to make a demo work. Choose safe defaults and document limitations.
6. Pin dependency versions and commit lockfiles (`go.sum`, `pnpm-lock.yaml`, Gradle version catalog + lockfiles).
7. Add automated tests for business logic, API behavior, protocol parsing, and critical UI flows. Tests live next to the code they test (`*_test.go`, `*.test.ts`, `src/test/`), not in a separate `tests/` tree.
8. Run formatter, linter, tests, and builds available in the current environment. Report the exact commands and honest results.
9. **Never claim a platform feature works unless it was executed on that platform** (real device, emulator, or Playwright browser project). Mark everything else "untested".
10. Never commit secrets, private keys, signing keys, real user data, or production credentials. Keep `.env.example` current.
11. Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`). No force-push. Do not touch unrelated branches.
12. Accessible, responsive UI: keyboard support, semantic controls, focus states, contrast, and loading/empty/error states.
13. When requirements conflict, priority is: security > data integrity > platform policy > explicit decisions in `docs/PRODUCT_REQUIREMENTS.md` > everything else.
14. Do not create empty folders to match a target tree. Every committed artifact has a purpose.

## 4. Definition of done (per feature)

- UX states implemented: loading, empty, populated, error, offline, permission-denied, success, partial.
- Any screen that sends, receives, or waits for a peer drives the keep-screen-on controller and shows its status row (`docs/ARCHITECTURE.md` §7).
- Happy path works end-to-end on at least one tested platform.
- API and data model documented (OpenAPI for REST, `shared/protocol/websocket-events.json` for WS).
- Automated tests cover the critical logic and run in CI.
- No dead buttons or fake data remain.

## 5. Toolchain and version pins

Verify the installed versions in the environment at Phase 0, then pin them in the repo and record the decision in `docs/ADR/`. Defaults to start from:

| Area | Pin |
|---|---|
| Go | latest 1.x stable available in the environment; `go.mod` `go` directive set to it |
| Node | 22 LTS, managed by `.nvmrc`; package manager **pnpm** via `packageManager` field |
| Web | React 18+, TypeScript strict, Vite, Tailwind CSS (single styling approach), TanStack Query, Lucide icons |
| Android | Kotlin 2.x, Jetpack Compose with Compose BOM, AGP 8.x, JDK 17, **minSdk 26, targetSdk 35** |
| iOS | Swift 5.10+ (Swift 6 language mode where the toolchain allows), SwiftUI, **iOS 16 minimum**, Xcode 16.x, Swift Package Manager only, project generated by **XcodeGen** from `ios/project.yml` (no hand-edited `.pbxproj` committed), SwiftLint + SwiftFormat, CryptoKit, WebRTC via the `stream-webrtc-ios` SPM package (or Google's `WebRTC` xcframework; decide in ADR) |
| DB | PostgreSQL 16, SQL migrations via `golang-migrate` or `goose` (pick one in Phase 1 ADR) |
| TURN | coturn with `use-auth-secret` time-limited credentials |
| Containers | Docker Compose v2; reverse proxy is **Caddy** (automatic HTTPS) |
| E2E | Playwright, projects: `chromium-desktop`, `firefox-desktop`, `webkit-desktop`, `android-chrome` (Pixel 7 profile), `ios-safari` (iPhone 14 profile, WebKit engine). Native apps: Android emulator (API 34) and iOS Simulator (iPhone 15, latest iOS runtime on the macOS runner) |

## 6. Repository layout

```text
share_anywhere/
├── CLAUDE.md                      # this file
├── CLAUDE_DESIGN_AND_BUILD_PROMPT.md  # master index and how to run a phase
├── README.md
├── .env.example
├── .github/workflows/             # ci.yml, nightly.yml, android-emulator.yml
├── docker-compose.yml             # postgres, coturn, caddy, backend, web (dev)
├── docs/
│   ├── PRODUCT_REQUIREMENTS.md
│   ├── TESTING_AND_CI.md
│   ├── phases/                    # PHASE_0 … PHASE_9, README.md
│   ├── ADR/
│   ├── ARCHITECTURE.md, UX_SCREEN_MAP.md, SECURITY_MODEL.md, API.md   # exist from planning; phases keep them current
│   ├── TRANSFER_PROTOCOL.md, CLIPBOARD_PROTOCOL.md, DESIGN_SYSTEM.md   # produced by phases
│   └── runbooks/
├── backend/
│   ├── cmd/server/
│   ├── internal/
│   │   ├── platform/      # config, db, http server, middleware (access levels, rate limiting), logging, ws hub + tickets
│   │   ├── devices/       # anonymous device identity, signed access tokens, refresh rotation, device registry, revocation
│   │   ├── auth/          # accounts, account sessions layered on device identity, password hashing, account keys (wrapped ADK), history sync
│   │   ├── sharing/       # share sessions, participants, shared files, capability tokens
│   │   ├── transfers/     # per-recipient transfer records and state machine
│   │   ├── signaling/     # WebRTC signaling messages over WS
│   │   ├── turncreds/     # time-limited TURN credential issuing
│   │   └── clipboard/     # events, cursors, settings
│   └── migrations/
├── web/                   # Vite app; src/app, components, features/*, lib, styles, test
├── android/               # Gradle project; app/, gradle/libs.versions.toml
├── ios/                   # XcodeGen project.yml, ShareAnywhere/ (app), ShareAnywhereCore/ (SPM package: protocol, engine, crypto), Tests/
├── shared/protocol/       # openapi.yaml, websocket-events.json, schemas/
├── infra/                 # coturn/, caddy/
└── scripts/               # dev.sh, gen-fixture.sh, e2e.sh
```

Eight backend packages is the ceiling for MVP. Route selection, ETA, and fallback logic live in the **clients** (`web/src/features/transfer/engine`, Android `transfer/engine`, iOS `ShareAnywhereCore/Transfer`), not in the backend. The backend records the chosen route for metrics only.

## 7. Security non-negotiables

- **File sharing never requires an account.** Do not add sign-in gates, account checks, or "create an account to continue" prompts to any Transfer flow, onboarding, History, or Settings. Account-only features are exactly: Clipboard Sync, the account-wide Devices list, cloud history sync, and Cloud Distribution as a sender (PRD §2). Changing this needs an ADR.
- Every client request carries a server-signed **device access token** (JWT, EdDSA/Ed25519 only, 15-minute TTL). Guests have one too; an account session only adds the `acct` claim. Refresh secrets rotate on every use with reuse detection (`docs/SECURITY_MODEL.md` §4).
- Every route declares an access level (`public`, `device`, `participant`, `account`, `account+device`) in OpenAPI `x-sa-access` matching `docs/API.md`, and a test asserts the backend enforces it.
- Rate limits keyed by IP **and** device protect device creation, session creation, code lookup and failed lookups, joins, TURN credentials, and WebSockets (`docs/SECURITY_MODEL.md` §5). Never remove a limit to make a test pass; inject a test clock or test config instead.
- Server authorizes every resource access. Never trust client-supplied `user_id` or `device_id`; identities come only from the verified token.
- **Open join is the default, so the six-digit code admits people and must be treated as a short-lived secret:** 5-minute rotation, invalid once the session is full or not accepting, per-IP and per-device failed-lookup lockouts, and a global protected mode that forces approval for code joins when guessing spikes (`docs/SECURITY_MODEL.md` §3). Never lengthen the code lifetime or loosen these limits without an ADR. Share links and QR payloads carry a high-entropy (≥ 128-bit), short-lived, revocable capability token.
- Receivers get file metadata beyond the join preview, signaling, TURN, and transfer access only once `JOINED` (immediately with open join, after approval when approval is required or protected mode applies). Both sides see the same verification words. Remove and Block revoke access at once; Block also covers the IP /64 for the session.
- Max five receivers is enforced atomically in the database (row lock or constraint), never by client count.
- WebSocket upgrade requires a one-time ticket (`POST /v1/ws/ticket`, 30 s) and checks `Origin` before joining any room.
- API calls use the bearer access token on all clients. The Web keeps the refresh secret only in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to the refresh endpoint and requires a custom header on refresh; access tokens live in memory, never in localStorage. Android keeps the refresh secret in Keystore-backed storage, iOS in the Keychain (`ThisDeviceOnly`).
- Clipboard content is encrypted client-side (AES-256-GCM, unique nonce, versioned keys). The server stores ciphertext and never logs payloads.
- TURN credentials are HMAC time-limited (coturn `use-auth-secret`), TTL 30 min for guest devices and 60 min for account devices, issued only to the sender and joined receivers of an active session.
- Cloud Distribution uploads require a signed-in sender; guest receivers may download from sessions they joined.
- Parameterized SQL only. Validate all inputs. CSP and safe headers on Web.
- Logs redact tokens, emails, and personal data.

## 8. CI expectations

Every PR must pass `.github/workflows/ci.yml`. Path filters decide which jobs run. Required checks: `backend`, `web`, `e2e-web`, `protocol`, `security`. `android` and `android-emulator` become required once Phase 6 lands; `ios` and `ios-simulator` once Phase 7 lands. Details in `docs/TESTING_AND_CI.md`. Never skip, disable, or quarantine a test to get green; fix it or revert.

## 8b. Feature flags for unbuilt account features

Accounts arrive in Phase 5A and Clipboard Sync in Phase 5B. Until then, build-time flags `accounts` and `clipboard` are off: the Clipboard tab is hidden, Settings shows "Guest" without a Sign in button, and Devices shows only "This device". Never ship a Sign in button or Clipboard screen that does nothing; turn the flag on in the phase that makes it work.

## 9. Phase exit report format

End every phase with a report in `docs/phases/reports/PHASE_N_REPORT.md` containing:

1. What was implemented.
2. Which screens/routes are usable, by platform.
3. Which end-to-end workflows were executed, as guest or signed in, and on what (browser project, Android emulator API level, iOS Simulator device and runtime).
4. Commands run and their results, including CI run links.
5. Required environment variables and external services.
6. Known limitations and untested platform behaviors.
7. Remaining backlog prioritized P0/P1/P2.
8. Local run instructions using Docker Compose.
9. Commit hashes created.

Separate **implemented and tested**, **implemented but untested**, **partially implemented**, and **planned**. Never write "complete" for scaffolding.
