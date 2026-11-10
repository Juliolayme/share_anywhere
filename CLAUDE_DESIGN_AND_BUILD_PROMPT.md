# Share Anywhere — Master Design & Build Prompt for Claude (v5)

> **Purpose:** Entry point for Claude Code sessions working on Share Anywhere. Version 1 of this file was a single 1,200-line brief covering every phase at once. Version 2 splits it into standing rules, product requirements, a testing/CI strategy, and one executable file per phase, and reorders the phases so that everything verifiable on GitHub Actions comes first. Version 3 makes file sharing **guest-first**: no account is needed to send or receive, and only Clipboard Sync and other account-wide features require signing in. Version 4 makes joining **open by default** (Require approval becomes an opt-in), keeps the screen on during transfers, and moves architecture, screen map, security model, and API into their own documents. Version 5 replaces code rotation with a 10-minute join window renewed by the sender.
>
> **Product:** Share Anywhere — cross-platform peer-to-peer file sharing and clipboard synchronization.
> **Repository:** <https://github.com/Juliolayme/share_anywhere>
> **Platforms in scope:** Android app (native Kotlin) + iOS app (native Swift/SwiftUI) + Web app (React + TypeScript) for PC and mobile browsers. No desktop agent.
> **Identity model:** guest-first. Every install gets an anonymous, server-signed device identity; accounts are optional and unlock only Clipboard Sync, the account Devices list, cloud history, and Cloud Distribution as a sender.
> **Working language:** English in source and docs; UI shipped in English and Vietnamese.

---

## How to run a phase

Give Claude Code this instruction, replacing `N`:

```text
Read CLAUDE.md, docs/phases/README.md and docs/phases/PHASE_N_*.md. Execute Phase N only.
Keep CI green after every commit. When the exit gate is met, or when you must stop,
write docs/phases/reports/PHASE_N_REPORT.md and stop. Do not start Phase N+1.
```

Phase 5 runs as two milestones, 5A and 5B; use `PHASE_5A_REPORT.md` and `PHASE_5B_REPORT.md`.

Claude then reads the referenced sections of `docs/PRODUCT_REQUIREMENTS.md` and `docs/TESTING_AND_CI.md` on demand. Work is committed on a feature branch and verified by `.github/workflows/ci.yml` before merging to `main`.

## Document map

| File | Role | Changes between sessions? |
|---|---|---|
| `CLAUDE.md` | Standing rules: role, mandatory rules, definition of done, toolchain pins, repo layout, security non-negotiables, CI expectations, report format | Rarely |
| `docs/PRODUCT_REQUIREMENTS.md` | What to build: decisions, brand, IA, screen behavior rules, transfer and clipboard behavior, acceptance matrix | Only via an ADR |
| `docs/ARCHITECTURE.md` | Components, identity and join flows, state machines, routes and TURN, keep-screen-on lifecycle, server data model | Updated by phases |
| `docs/UX_SCREEN_MAP.md` | Every screen with destination, Guest vs Signed in content, primary action, platform differences | Updated by phases |
| `docs/SECURITY_MODEL.md` | Join modes, tokens, rate limits, lifetimes, threat model, privacy | Extended by Phases 1, 2, 5, 8; reviewed in 9 |
| `docs/API.md` | Endpoints, access levels, errors, WebSocket events; kept in agreement with `openapi.yaml` | Updated by phases |
| `docs/TESTING_AND_CI.md` | GitHub Actions workflows, platform emulation (Playwright desktop + Pixel 7 + iPhone 14 WebKit profiles, Android emulator with KVM), test conventions, fixtures | Grows with phases |
| `docs/phases/README.md` | Phase order and exit gates | Rarely |
| `docs/phases/PHASE_0…9_*.md` | Scope, deliverables, tests, CI changes, exit gate for each phase | One file per phase |
| `docs/phases/reports/` | Honest per-phase reports written by Claude | Every phase |
| `docs/ADR/` | Architecture decisions, created from Phase 0 onward | As decided |

## Phase order

| # | Phase | Verified on |
|---|---|---|
| 0 | Foundation, design system, brand, CI skeleton | CI jobs on docs and empty projects |
| 1 | Backend core, anonymous device identity, guest-first Web shell | 5 Playwright projects, guest only |
| 2 | Share sessions, open join, signaling: **first vertical slice, no account** | Web ↔ Web guests, mobile browser profiles for join page |
| 3 | Web ↔ Web P2P file transfer | Chromium, Firefox, WebKit desktop; Pixel 7 and iPhone 14 profiles |
| 4 | Multi-receiver, reconnect, resume hardening | Web, nightly five-receiver run |
| 5 | Accounts (5A) and Clipboard Sync v1 (5B) | Web; guest blocked from clipboard; granted and denied permission paths |
| 6 | Android app | Android emulator API 34 (29 and 35 nightly), Android ↔ Web interop |
| 7 | iOS app | iOS Simulator on macOS runner (iPhone 15, latest runtime; iOS 16 runtime nightly), iOS ↔ Web interop |
| 8 | Route strategy, TURN fallback, optional Cloud | Forced relay on Web, Android emulator and iOS Simulator, MinIO |
| 9 | Hardening and release readiness | All |

The reasoning for this order: a cloud CI environment can run Go, Node, five emulated browsers, an Android emulator (Linux runner) and an iOS Simulator (macOS runner), but not a real phone. Building the protocol and the Web client first makes every later Android and iOS claim testable against a known-good peer. Phases 6 and 7 both depend only on Phase 5 and may run in parallel in separate sessions on separate branches.

## What changed from v1 and why

| v1 weakness | v2 resolution |
|---|---|
| One 1,200-line prompt for eight phases; a single session could not finish it and would drift | Split into standing rules, PRD, CI strategy, and nine phase files with explicit exit gates and a "do not start the next phase" rule |
| Phase 3 started P2P with Android ↔ Web, which cannot be verified without a device | Phase 3 is Web ↔ Web in two Playwright contexts; Android moves to Phase 6 and is verified on emulators plus a Playwright peer |
| Auth, email verification, guest mode left as "if implemented" | Fixed in PRD §2 and revised in v3: guest-first anonymous device identity for all file sharing; email + password with Argon2id layered on the device identity; no email verification in v1 |
| Clipboard key bootstrap for new devices undefined | PRD §7.5: Account Data Key with QR pairing over ephemeral X25519, 12-word recovery phrase, versioned rotation on revoke; also encrypts cloud history |
| Route strategy, ETA, fallback, cost listed as backend packages while measurements happen in clients | Clients own route selection and ETA; backend records route and issues TURN credentials; backend package count capped at eight |
| Browser large-file limits mentioned vaguely | PRD §6.8 capability matrix per engine with detection before transfer and honest "tested on emulation" labels |
| Android foreground-service time limits on Android 15 not mentioned | PRD §2: `dataSync` budget handling with checkpoint/notify/resume; `JobScheduler` user-initiated transfer evaluated in Phase 6 |
| No toolchain or Android SDK pins | `CLAUDE.md` §5: Node 22, pnpm, JDK 17, minSdk 26 / targetSdk 35, PostgreSQL 16, Caddy, Tailwind only |
| PostgreSQL sequence ordering caveat raised without a solution | PRD §7.4: per-user advisory lock assigns `seq` so cursors are safe |
| TURN credential handling vague | `docs/ARCHITECTURE.md` §6: coturn `use-auth-secret` HMAC credentials for joined participants only; 30 min TTL and tighter limits for guests, 60 min for accounts |
| No CI definition; testing described as a wish list | `docs/TESTING_AND_CI.md`: `ci.yml`, `nightly.yml`, reusable Android emulator workflow, path filters, required checks per phase, fixtures, reporting |
| No iOS coverage statement | Native iOS app added as Phase 7 (SwiftUI, iOS 16+, verified on iOS Simulator in CI); Web app additionally verified on WebKit with an iPhone 14 profile for users without the app |
| `backend/tests/` tree against Go conventions | Tests live beside code; integration tests tagged |
| Final report asked for macOS instructions | Reports use Docker Compose instructions |

## v3 change: guest-first file sharing

| Area | Before (v2) | Now (v3) | Where |
|---|---|---|---|
| Who can send and receive | Accounts send; guests receive only | Everyone, no account | PRD §2, §5.3, §5.4 |
| First launch | Welcome, sign-in, device registration, checklist | Welcome → **Get started** → Transfer home | PRD §5.1, §4 |
| Identity | Cookie session (Web) or bearer token (Android) after sign-in | Anonymous server-signed device token for everyone; account adds an `acct` claim | `docs/SECURITY_MODEL.md` §4, `CLAUDE.md` §7 |
| Account-only features | Everything except receiving | Clipboard Sync, account Devices list, cloud history, Cloud as sender | PRD §2 |
| Clipboard tab for guests | Not reachable | Intro screen with Sign in / Create account; no clipboard access | PRD §5.9 |
| History | Server-side per account | Local on device; optional encrypted cloud sync when signed in | PRD §2, §5.6 |
| Settings for guests | n/a | "Guest" header with Sign in | PRD §5.8 |
| Signing in | Gate before use | Optional; keeps the transfer running; choose to add the device and copy history | PRD §2 |
| Signing out | Ends session | Removes device from account, issues a new anonymous identity | PRD §2 |
| Database | `user_id` on sessions | `owner_device_id` required, `owner_user_id` nullable | `docs/ARCHITECTURE.md` §8 |
| API | Mostly authenticated | Five access levels declared per route in OpenAPI | `docs/API.md` |
| Abuse controls | Login and code limits | IP + device limits on device creation, sessions, code lookup, joins, TURN, WebSocket; proof-of-work; TTLs | `docs/SECURITY_MODEL.md` §5, §6 |
| Cloud Distribution | Consent only | Also requires a signed-in sender; guest receivers allowed | PRD §2, §6.6 |
| Threat model | Generic | Anonymous-use abuse cases with mitigations and residual risk | `docs/SECURITY_MODEL.md` §7 |
| Phase order | Accounts in Phase 1 | Accounts in Phase 5A, right before Clipboard; Phases 1–4 need no account | `docs/phases/README.md` |

## v4 change: open join, keep screen on, split documents

| Area | Before (v3) | Now (v4) | Where |
|---|---|---|---|
| Joining | Sender approves every receiver | Valid code, link, or QR joins immediately; **Require approval** is optional, default off; sender can Remove, Block, Stop accepting at any time | PRD §2, §5.3, §5.4; `docs/SECURITY_MODEL.md` §3 |
| Six-digit code | Lookup key only | Short-lived access secret in open-join sessions: 10-min join window shared with link and QR, renewed by Create new code, ends when full or not accepting, IP and device lockouts (window revised in v5) | `docs/SECURITY_MODEL.md` §3, §5 |
| Guessing defense | Per-IP limits | Plus global **protected mode** forcing approval for code joins when guessing spikes; residual risk documented | `docs/SECURITY_MODEL.md` §3.1, §3.2 |
| Block | Same device only | Device ID and IP /64 for the session | `docs/SECURITY_MODEL.md` §3.1 |
| Participant states | `REQUESTED`, `APPROVED`, … | `REQUESTED` only when approval applies; `JOINED` grants access | `docs/ARCHITECTURE.md` §4.5 |
| Screen during transfers | Not specified | Kept on while sending, receiving, or waiting: iOS idle timer, Web Wake Lock with re-request and fallback reminder, Android keep-screen-on flag plus foreground service; auto-release; setting default on; status row | PRD §2, §5.10; `docs/ARCHITECTURE.md` §7 |
| Document layout | Architecture, API matrix, threat model inside the PRD | Separate `ARCHITECTURE.md`, `UX_SCREEN_MAP.md`, `SECURITY_MODEL.md`, `API.md`; PRD points to them | Document map above |

## v5 change: 10-minute join window

| Area | Before (v4) | Now (v5) | Where |
|---|---|---|---|
| Code lifetime | Code rotated every 5 min while the session accepted receivers; link and QR lasted 15 min; waiting sessions expired after 30 min | Code, link, and QR share one join window of at most 10 min; afterwards nobody can join until the sender taps **Create new code** for a fresh 10 min with a new code; no 30-min waiting expiry | `docs/SECURITY_MODEL.md` §3.0, §6 |
| Joined receivers | — | Unaffected by the window; the session follows its 24 h guest / 72 h signed-in lifetime | `docs/SECURITY_MODEL.md` §3.0 |
| Session screen | Rotation countdown | Countdown from 10:00, then "Code expired — Create new code" ("Mã đã hết hạn — Tạo mã mới"); "Session full" when 5 are in | `docs/UX_SCREEN_MAP.md` TR-4, PRD §5.3 |
| Guessing risk | Exposure lasted as long as the session accepted receivers | At most 0.3 % per session per 10-min window at the protected-mode ceiling; recalculated model | `docs/SECURITY_MODEL.md` §3.2 |
| API | `renew` rotated the link | `renew` = Create new code; `join_window_ends_at`, `server_time`, `410 join_window_expired` | `docs/API.md` §2.2, §3 |
| Keep screen on while waiting | Up to the 30-min waiting expiry | Only while the join window is open, at most 10 min per window | `docs/ARCHITECTURE.md` §7.1 |

## Backlog outside current scope

- Image and file clipboard payloads.
- P2P cascade / receiver seeding.
- Optional IME on Android; custom keyboard extension on iOS.
- iOS Share Extension (send files from other apps) and Android share-sheet target: add after Phase 9.
- App Store / Play Store release pipelines (TestFlight, Play internal track): CI builds unsigned artifacts only.
- Observability dashboards beyond the Prometheus endpoint.
- Account suspension and abuse-report tooling for Cloud Distribution and session reports.
- Shared rate-limit store (PostgreSQL or Redis) for multi-instance deployments.

## First action in any session

Run the "How to run a phase" instruction for the lowest phase whose report does not yet exist in `docs/phases/reports/`. If `docs/phases/reports/` is empty, start with Phase 0.
