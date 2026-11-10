# QA — Phase 0

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## Round 1 — commit 1652d6a — FAIL

| Severity | Count | Summary |
|---|---|---|
| P0 | 4 | gitleaks flagged a JWT-shaped test fixture; Go 1.25 pin unsupported with 20 reachable stdlib vulnerabilities; `pnpm audit` 2 critical / 5 high; therefore CI not green |
| P1 | 7 | Claude Design handoff missing (blocks tokens, DESIGN_SYSTEM.md, screen map extension, brand assets, i18n catalogs); Phase 0 report missing |
| P2 | 13 | Log redaction gaps, middleware not WebSocket-ready, lint guard bypassable, token check could no-op, sourcemaps served, coturn ranges, focus style, CI hygiene, ADR citations, layout drift |

Verified by QA in round 1: tokens pipeline, script tests (6/6), markdown lint, web format/lint/typecheck/tests (8/8)/build, `/brand` excluded from production bundle, backend vet/lint/tests including a real PostgreSQL ping, both Compose stacks healthy with host-built images, CI `backend`, `web`, `compose` (real Dockerfiles), `docs`, `protocol` green.

### Resolution of round 1 findings (commit 754b7f4)

| Finding | Severity | Resolution |
|---|---|---|
| gitleaks: JWT fixture in `logging_test.go` | P0 | Fixture built at runtime; `.gitleaksignore` holds the single historical fingerprint (no force-push allowed). Local gitleaks: no leaks |
| Go 1.25 unsupported, govulncheck 20 findings | P0 | `go 1.27`, `toolchain go1.27.3`, `golang:1.27-alpine`, golangci-lint v2.15.0, govulncheck v1.9.0. Local govulncheck: no vulnerabilities |
| `pnpm audit` high/critical | P0 | vitest 5.1.0, markdownlint-cli2 0.24.0, React Router 7, overrides for re2js 2.8.7, katex 0.18.2, minimatch 11.0.1 (typescript-estree). Local `pnpm audit`: no known vulnerabilities |
| CI not green | P0 | Fixed for the built scope: CI run 42771308979 on 754b7f4 has `security` (including Trivy, never run before), `web`, `compose`, `protocol`, `docs` green and `backend` tests and lint green |
| Design handoff and design-dependent deliverables | P1 | **Open — blocked.** DesignSync refused: "needs design-system authorization"; `/design-login` cannot run in this cloud session. Needs the user to provide the files (see the Phase 0 report) |
| Phase 0 report missing | P1 | Written as `docs/phases/reports/PHASE_0_REPORT.md` with status "blocked on design import" |
| Log redaction: errors and groups | P2 | Fixed with tests (`TestRedactsTokensInsideErrors`, `TestRedactsMembersOfSensitiveGroups`) |
| Middleware Flush/Hijack, ErrAbortHandler, double write | P2 | Fixed with tests. Long-lived WebSocket timeouts are handled in Phase 2 |
| Lint guard bypass | P2 | `no-restricted-properties` for `window`/`globalThis`/`self` Web Storage; probe confirms detection |
| `tokens:check` could no-op | P2 | `pathToFileURL(realpathSync(argv[1]))` comparison |
| Generated tokens edited by hand not checked | P2 | `web` job runs `pnpm tokens:check`; `shared` filter includes `web/src/styles/tokens.*` |
| Source maps served | P2 | `sourcemap: 'hidden'`; maps deleted in the web image |
| coturn ranges and exposure | P2 | More reserved ranges denied; dev ports bound to loopback. Secret on the command line remains for dev/CI; production config file is Phase 9 |
| Focus on theme picker | P2 | `focus-within` outline on the label |
| CI on Node 20 actions | P2 | checkout@v5, setup-node@v5, setup-go@v6 |
| ADR citations | P2 | ADR 0003 and 0005 cite PRD §2 |
| Web CSP `unsafe-inline` styles, headers, non-root Caddy | P2 | Deferred to Phase 1 hardening |
| Scaffold copy on `/` | P2 | Replaced by the app shell in Phase 1 |
| Web layout vs `CLAUDE.md` §6 | P2 | Aligned in Phase 1 |
| Actions pinned by tag; duplicate push/PR runs | P2 | Accepted for now; revisit in Phase 9 |

## Round 2 — commit 29a3e09 — FAIL

No P0. Five P1 and thirteen P2 findings on the design work; every check and CI run green. Fixed in 8993201:

| Finding | Severity | Resolution |
|---|---|---|
| Logo wordmark unreadable in dark theme on `/` (1.23:1) | P1 | `Logo` follows the theme by default through `--sa-logo-*` variables; the token check fails if the wordmark is below 4.5:1 on `bg` or `surface` in either theme; tests added; measured `#FFFFFF` on `#0B1A33` |
| i18n catalogs missed the `VV`, `XX`, `YY`, `LBL` tables (including "Start sharing" and the screen-on pill copy) | P1 | The generator extracts every `{en, vi}` table, the Handoff Checklist microcopy, and a hand-written product overlay; an unparseable locale table fails the run; 1459 keys each; tests assert the key strings |
| `DESIGN_SYSTEM.md` missing badges, Remove/Block, Require approval, pill, account-required intro, validation patterns, breakpoint decision | P1 | Added all, plus design-internal conflicts and the sample-data rule for strings |
| PRD-required UI absent from the design not recorded | P1 | `DESIGN_DEVIATIONS.md` section E with component and string source for each; strings in `shared/i18n/product.json` |
| Keep-screen-on docs contradicted each other | P1 | One pill definition with six states, strings, and tap behavior in `ARCHITECTURE.md` §7.3; PRD, UX map, phases, and `CLAUDE.md` point to it |
| `brand:check` only checked non-empty rasters | P2 | Pixel comparison (ICO entries too); proven to fail on a replaced PNG |
| iOS icons had an alpha channel | P2 | `removeAlpha()` for iOS and apple-touch icons; verified 3 channels |
| Maskable scale 0.56 | P2 | Design value 64/96 |
| Dotless favicon rule inconsistent | P2 | One rule (≤ 16 px dotless), deviations C3 |
| No standalone 16/32 PNGs | P2 | Added |
| Component state colors not tokenized | P2 | Listed in `DESIGN_SYSTEM.md` §6; tokens added in Phase 1 before Button and Input |
| Design-internal value conflicts not noted | P2 | `DESIGN_SYSTEM.md` §1.1 |
| Contrast pairs `send` on `send-soft`, `fg-3` on `surface-2` | P2 | `fg-3` pairs checked at 3:1; `send-ink` required on `send-soft` (deviations C4) |
| Catalogs carry sample data and fragments | P2 | Rule in `DESIGN_SYSTEM.md` §1.2; parameterized keys in `product` |
| New screen-map rows missing from main tables | P2 | ON-3, RX-5b, AC-8 added |
| Settings default for Require approval | P2 | Adopted (deviations B9, PRD §5.8) |
| Stale "Get started" in the master prompt | P2 | Fixed |
| `CLAUDE.md` edited | P2 | Wording only ("security words", "screen-on pill"); reported to the user |
| Minor markup | P2 | Duplicate focus class removed; `/` heading announces the name once |

## Round 3 — commit 8ef378e — FAIL

No P0. Two P1 and five P2 findings; all checks and CI run 42779955558 green.

| Finding | Severity | Resolution |
|---|---|---|
| Keep-screen-on copy still contradicted in ARCHITECTURE §7.2, PRD §5.10, Phase 2; wrong `common` key reference; RX-5 row missing the pill | P1 | §7.2 keeps mechanics only and points to §7.3 for states; PRD and Phase 2 name the §7.3 states and keys; key reference corrected; pill added to RX-5 |
| Catalogs missed the `TRP` pattern translations, inline `lang === 'vi'` strings, and PRD/ARCHITECTURE strings without a key | P1 | `TRP` converted (as text, never executed) into `<app>_patterns` templates; `product.json` gains `choose_save`, `code_expires_in`, `slots_left`, `peer_joined`, `sign_in_clipboard`, pill hints; PRD §9 microcopy is now a meaning → key table and a test fails if any key is missing; design wording adopted for the receiver code-expired and local-history labels (deviations B12, B13, E9, E10) |
| Report CI evidence stale | P2 | Cites run 42779955558 and the run history |
| State color list incomplete; warning banner text conflict | P2 | Completed in `DESIGN_SYSTEM.md` §6 and §1.1 |
| Scaffold `/` hard-coded copy | P2 | Replaced by the Phase 1 shell |
| `CLAUDE.md` wording edits need user sign-off | P2 | Reported to the user in the Phase 0 summary |
| UX map row drift | P2 | Fixed with P1-1 |

## Round 4 — commit 259582c — FAIL

No P0. Three P1 and several P2 findings; all checks and CI run 42781828564 green. The independent TRP check confirmed 25 of 25 conversions per app.

| Finding | Severity | Resolution |
|---|---|---|
| iOS background notification wording differed (PRD §2, Phase 7 vs ARCHITECTURE §7.3) | P1 | PRD and Phase 7 reference `ios.susp_h` ("Transfer paused — reopen the app to resume") |
| Native `L(en, vi)` connection-log strings not extracted | P1 | Extracted as text into `android_log` / `ios_log` (13 each); parameterized `product.log_*` keys for lines with sample values; test added |
| PRD strings without keys (after-sign-in choices, add device, history sync, background join notification, iOS guest Cloud prompt, cost unknown) | P1 | `product` keys added; docs reference keys; PRD §9 table extended; deviations A1 and E11 |
| Garbled HI-1 cell; B rows out of order; report commit table; pill tap quote; DESIGN_SYSTEM example strings; TRP count guard; positional-key meaning test; placeholder rule; QA agent "status row" | P2 | Fixed |
| `CLAUDE.md` wording edits need the user's sign-off; CI Node 20 action warnings | P2 | Reported to the user; Node 20 actions tracked for Phase 9 |

## Round 5 — commit d44226e — PASS

No P0 or P1. All three round-4 P1s verified fixed; no regressions. Every local check passed (tokens, i18n 1588 keys, brand 26 files, script tests 16/16, markdown lint, `pnpm audit`, web format/lint/typecheck/tests 14/14/build, backend gofmt/vet/golangci-lint/race tests including a real PostgreSQL ping, gitleaks on history and tree, both Compose configs) and CI run 42782979011 on d44226e was green in every job.

Not verified by QA, with where it is covered: local dev Compose stack (CI `compose` job with the real Dockerfiles; verified locally in rounds 1–2 and unchanged since); Firefox and WebKit rendering (Phase 1 `e2e-web`); Android adaptive icon masks and iOS asset catalog compilation (Phase 6 and 7 CI jobs); dependency review (runs on pull requests).

### Resolution of round 5 P2 findings (follow-up commit)

| Finding | Resolution |
|---|---|
| Web connection-log lines partly covered; percent vs bytes | `product.log_retry_requested`, `log_cloud_approved`, `log_cloud_budget` added; `log_connection_lost_at` and `log_reconnected_from` take `{done}` (a byte amount, as the Web design shows) and keep "— network changed" |
| `<app>_log` description and `log_sending_to` parameter | DESIGN_SYSTEM §1.2 describes `<app>_log` as the inline `L()` pairs; `product.live_sending_to` with `{n}` for the live receiver count |
| Inline-pair extractor had no completeness guard | `extractInlinePairs` fails when the number of `L(` calls differs from the pairs extracted and on a key collision with different text; test added (17/17) |
| "Signed in" badge without key or deviation row | `product.badge_guest` and `product.badge_signed_in`; DESIGN_SYSTEM cites them; deviation E12 |
| Literal quotes drifting from keys (PRD AC choices and clipboard fallback, UX TR-5 nudge, ARCHITECTURE iOS notification) | Replaced by `product.add_device`, `product.copy_history`, `product.clipboard_click_sync`, `product.stop_nudge`, `ios.susp_h` |
| Report references stale | Commit table names d44226e; CI evidence cites run 42782979011 |
| `CLAUDE.md` wording edits need the user's sign-off | Reported to the user in the Phase 0 summary |

**Phase 0 QA verdict: PASS.**
