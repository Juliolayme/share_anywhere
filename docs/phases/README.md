# Phases

Execution order, exit gates, and what each phase may touch. Run one phase per session. The order prioritizes what can be **built and verified in a cloud CI environment first** (backend, Web, emulated browsers), then Android on emulators, then routing and cloud which need TURN infrastructure.

| # | Phase | Primary platforms verified | Exit gate |
|---|---|---|---|
| 0 | Foundation, design system, brand, CI skeleton | none (docs + tooling) | `ci.yml` green with `docs`, `security`, and empty-project `backend`/`web` jobs; brand preview page renders in Storybook or `/brand` |
| 1 | Backend core, auth, devices, Web shell | Web (5 Playwright projects, smoke) | Sign up, sign in, device registration work end-to-end in all 5 browser projects; backend coverage ≥ 70 % on auth/devices |
| 2 | Share sessions, pairing, approval, signaling | Web ↔ Web (two contexts) + mobile projects for join page | Vertical slice: create session → QR/code/link → receiver joins from `ios-safari` and `android-chrome` → sender approves on `chromium-desktop`; sixth receiver rejected under race test |
| 3 | Web ↔ Web P2P file transfer | Web, all projects where capability allows | 256 MB sparse fixture transfers Chromium→Chromium, Chromium→Firefox, Chromium→WebKit with hash match; pause/resume; reload-and-resume via bitmap |
| 4 | Multi-receiver, reconnect, resume hardening | Web | Five receivers concurrent in nightly; throttled receiver does not block; disconnect/reconnect resumes from bitmap |
| 5 | Clipboard Sync v1 (protocol, crypto, Web client) | Web | Encrypted events round-trip between two Web contexts with paired keys; denied-permission paths pass in Firefox/WebKit; recovery phrase restores key; DB contains no plaintext |
| 6 | Android app | Android emulator API 34 (+29, 35 nightly), Android ↔ Web interop | Emulator instrumentation suite green; Android→Web and Web→Android transfers verified in `nightly.yml`; clipboard foreground/background tests pass |
| 7 | Route strategy, TURN, optional Cloud Distribution | Web + emulator with forced relay | Forced-relay UDP and TCP/TLS transfers pass; route migration mid-transfer resumes; Cloud consent + budget guard tested against MinIO |
| 8 | Hardening and release readiness | all | Security review, a11y pass, failure injection, deployment runbook, release checklist, known limitations |

## Rules

- A phase starts only when the previous phase's exit gate is green on `main`.
- Each phase file lists **Scope**, **Out of scope**, **Deliverables**, **Tests to add**, **CI changes**, **Exit gate**, **Report**.
- If a phase cannot be completed in one session, finish to a buildable, green state, write the report with the exact remaining items, and stop. Do not start the next phase.
- Reports go to `docs/phases/reports/PHASE_N_REPORT.md`.
