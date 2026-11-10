# Phases

Execution order, exit gates, and what each phase may touch. Run one phase per session. The order prioritizes what can be **built and verified in a cloud CI environment first** (backend, Web, emulated browsers), then Android on emulators and iOS on simulators, then routing and cloud which need TURN infrastructure.

| # | Phase | Primary platforms verified | Exit gate |
|---|---|---|---|
| 0 | Foundation, design system, brand, CI skeleton | none (docs + tooling) | `ci.yml` green with `docs`, `security`, and empty-project `backend`/`web` jobs; brand preview page renders in Storybook or `/brand` |
| 1 | Backend core, anonymous device identity, guest-first Web shell | Web (5 Playwright projects, guest only) | Welcome → Transfer home with no sign-in screen in all 5 projects; anonymous identity, token refresh and reuse detection, device-creation rate limit tested; local History store works; no account code exists |
| 2 | Share sessions, joining, signaling — **first vertical slice, no account** | Web ↔ Web (two guest contexts) + mobile projects for join page | Guest open-join slice: create session on `chromium-desktop` → QR/code/link → guest receiver from `ios-safari` and `android-chrome` joins immediately → verification words match → Remove/Block work; Require approval path, protected mode, and sixth-receiver race tested; rate limits, lockouts, lifetimes, and Web keep-screen-on while waiting tested |
| 3 | Web ↔ Web P2P file transfer | Web, all projects where capability allows | 256 MB sparse fixture transfers Chromium→Chromium, Chromium→Firefox, Chromium→WebKit with hash match; pause/resume; reload-and-resume via bitmap |
| 4 | Multi-receiver, reconnect, resume hardening | Web | Five receivers concurrent in nightly; throttled receiver does not block; disconnect/reconnect resumes from bitmap |
| 5 | Accounts (5A) and Clipboard Sync v1 (5B) on Web | Web | **5A:** sign-up/sign-in/sign-out, post-sign-in choices, sign-in during an active transfer does not interrupt it, account Devices list, ADK pairing and recovery, encrypted history sync, guest tokens get `403 account_required`. **5B:** guest sees the Clipboard intro with zero clipboard API calls; encrypted events round-trip between two signed-in contexts; denied-permission paths pass in Firefox/WebKit; DB contains no plaintext |
| 6 | Android app | Android emulator API 34 (+29, 35 nightly), Android ↔ Web interop | Emulator instrumentation suite green including open join and keep-screen-on; Android→Web and Web→Android transfers verified in `nightly.yml`; clipboard foreground/background tests pass |
| 7 | iOS app | iOS Simulator iPhone 15 (SE, 15 Pro Max, iOS 16 runtime nightly), iOS ↔ Web interop | Simulator XCUITest suite green including open join and keep-screen-on; `ShareAnywhereCore` tests pass shared vectors; iOS→Web and Web→iOS transfers verified in `nightly.yml`; clipboard foreground/background and `UIPasteControl` tests pass; background-suspend resume test passes |
| 8 | Route strategy, TURN, optional Cloud Distribution | Web, Android emulator, iOS Simulator with forced relay | Forced-relay UDP and TCP/TLS transfers pass on all three clients; route migration mid-transfer resumes; Cloud consent + budget guard tested against MinIO |
| 9 | Hardening and release readiness | all | Security review, a11y pass (axe, TalkBack, VoiceOver), failure injection, deployment runbook, release checklist, known limitations |

## Rules

- A phase starts only when the previous phase's exit gate is green on `main`. Exception: Phases 6 (Android) and 7 (iOS) both depend on Phase 5 only and may run in parallel on separate branches; Phase 8 starts when both are merged.
- Each phase file lists **Scope**, **Out of scope**, **Deliverables**, **Tests to add**, **CI changes**, **Exit gate**, **Report**.
- If a phase cannot be completed in one session, finish to a buildable, green state, write the report with the exact remaining items, and stop. Do not start the next phase.
- Reports go to `docs/phases/reports/PHASE_N_REPORT.md`.
