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

## Round 2

Pending: re-run after the design handoff is imported, since the remaining P1 findings all depend on it.
