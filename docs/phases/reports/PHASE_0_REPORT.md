# Phase 0 report — Foundation

Status: **partially implemented; blocked on the Claude Design import.** The design-independent half of Phase 0 is implemented and tested. Every design-dependent deliverable waits for `design/claude-design/`, which could not be imported from this cloud session. The exit gate is not met, so Phase 1 has not started.

Date: 2026-11-10. Branch: `claude/practical-lovelace-avlb5g`.

## Inventory

| Item | Value |
|---|---|
| Repository at start | Documentation only (`CLAUDE.md`, master prompt, `docs/`) |
| Go | go1.24.7 installed; module pins `go 1.27` / `toolchain go1.27.3` (auto-downloaded) |
| Node | v22.23.4 |
| pnpm | 10.28.0 |
| JDK | OpenJDK 21.0.12 (CI will use 17 for Android) |
| Gradle | 8.14.3 |
| Android SDK | not available |
| Xcode / Swift | not available (Linux) |
| Docker | Engine 29.9.2, Compose v5.6.1 (daemon started manually) |
| PostgreSQL | 16.15 (local cluster, stopped by default) |
| Playwright | 1.63.0 with Chromium only (Firefox and WebKit run in CI) |
| golangci-lint | v2.15.0 (installed with Go 1.27.3) |

Exact pins and the reasons for them are in `docs/ADR/0001-monorepo-and-toolchain.md`.

## 1. What was implemented

### Implemented and tested

- **Backend skeleton** (`backend/`): validated configuration, JSON logging with redaction of tokens, secrets, emails, codes, IPs, tickets, JWT-shaped strings (including inside errors and sensitive groups), `/healthz`, `/readyz` with a database check that hides error details, JSON 404/405, security headers, request logging without query strings, panic recovery that respects `http.ErrAbortHandler`, middleware ready for WebSocket hijacking, graceful shutdown, and a `-healthcheck` flag for distroless images.
- **Design token pipeline**: `shared/design/tokens.json` with a JSON Schema, a WCAG contrast check for every declared text pair (4.5:1) and non-text pair (3:1) in both themes, a generator for Web CSS variables and TypeScript, and `--check` mode for CI. Kotlin and Swift targets are documented hooks for Phases 6 and 7.
- **Web scaffold** (`web/`): Vite 6, React 18.3.1, strict TypeScript, Tailwind wired only to token variables, theme preference (system, light, dark), dev-only `/brand` token preview excluded from production builds, hidden source maps, lint guard against Web Storage outside the preference wrapper.
- **Docker Compose**: development stack with HTTPS through Caddy's internal CA on `https://localhost:8443`, and a CI stack on `http://localhost:8080`; coturn with `use-auth-secret`, user quota, and relaying blocked to private and reserved ranges.
- **CI** (`.github/workflows/ci.yml`): path-filtered `docs`, `security` (gitleaks, govulncheck, pnpm audit, dependency review on PRs, Trivy), `backend`, `web`, `protocol`, and a `compose` smoke test using the real Dockerfiles. `nightly.yml` is a documented stub.
- **ADRs 0001 to 0006**, README, `.env.example`, `.nvmrc`, `.editorconfig`, `.gitignore`, `.npmrc`.
- **QA agent** `.claude/agents/qa-reviewer.md` and the first QA round (`docs/qa/PHASE_0_QA.md`).

### Implemented but provisional

- `shared/design/tokens.json` values are invented placeholders marked `$comment: PROVISIONAL`. They must be replaced with the values from `design/claude-design/Design System.dc.html`.

### Planned, blocked on the design import

| Deliverable | Needs |
|---|---|
| 0. `design/claude-design/` with the exported files | The files themselves |
| 3. Token values from the Design System | `Design System.dc.html` |
| 4. `docs/DESIGN_SYSTEM.md` | `Design System.dc.html`, `Handoff Checklist.dc.html` |
| 5. Screen map extension with Screen Map IDs, components, state models | `Screen Map.dc.html`, the three app files |
| 6. Logo and brand assets for Web, Android, iOS; `scripts/export-brand.mjs` | `Logo.dc.html`, `Brand.dc.html` |
| 6b. `shared/i18n/` EN/VI catalogs and their check | `i18n-strings.json` |

## 2. Screens and routes usable, by platform

| Platform | Usable |
|---|---|
| Web | `/` scaffold page (replaced in Phase 1), `/brand` in development builds only |
| Android | none (Phase 6) |
| iOS | none (Phase 7) |

## 3. End-to-end workflows executed

| Workflow | Where | Result |
|---|---|---|
| Dev Compose stack: postgres, backend, web, coturn, Caddy | Local Docker with host-built images | All services up; `/healthz` 200; `/readyz` database ok; web served over HTTPS |
| CI Compose stack with backend health check | Local Docker with host-built images | All healthy |
| CI Compose stack with the real Dockerfiles | GitHub Actions `compose` job | Green on run 42769204329 |
| `/brand` in light and dark | Chromium (Playwright), local dev server | Renders both themes (screenshots below) |

No product workflow exists yet, so nothing ran as guest or signed in.

![Brand preview, light](assets/phase0-brand-light.png)

![Brand preview, dark](assets/phase0-brand-dark.png)

## 4. Commands and results

| Command | Result |
|---|---|
| `pnpm tokens:check` | Schema valid, contrast AA, generated files current |
| `pnpm test:scripts` | 6 passed |
| `pnpm lint:md` | 0 issues |
| `pnpm audit` | No known vulnerabilities |
| `web`: `format:check`, `lint`, `typecheck`, `test`, `build` | All pass; 8 tests; main bundle well under the 120 kB gzip budget |
| `backend`: `gofmt -l`, `go vet`, `golangci-lint run` (v2.15.0) | Clean |
| `backend`: `go test -race ./...` | 5 packages pass, including a real PostgreSQL ping (run by QA) |
| `govulncheck` v1.9.0 on Go 1.27.3 | No vulnerabilities |
| gitleaks v8.24.3 | No leaks (one historical fixture ignored by fingerprint) |

CI runs on this branch: <https://github.com/Juliolayme/share_anywhere/actions?query=branch%3Aclaude%2Fpractical-lovelace-avlb5g>. Run 1 was cancelled by run 2. Run 2 (1652d6a) failed in `security` on gitleaks; QA then found the Go and npm vulnerabilities that the same job would have hit. Run 3 (754b7f4, <https://github.com/Juliolayme/share_anywhere/actions/runs/42771308979>) carries the fixes: `security` (gitleaks, govulncheck, pnpm audit, Trivy on the Go 1.27 backend image), `web` (including the image build), `compose` (real Dockerfiles plus smoke test), `protocol`, and `docs` are green, and `backend` passed vet, golangci-lint, and race tests (its final image build was still running when this report was written; the identical image was already built by `security`).

## 5. Environment variables and external services

All variables are listed in `.env.example`: `SA_ENV`, `SA_HTTP_ADDR`, `SA_LOG_LEVEL`, `SA_SHUTDOWN_TIMEOUT`, `SA_ALLOWED_ORIGINS`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `TURN_SHARED_SECRET`, `TEST_DATABASE_URL`. No external service is required yet.

## 6. Known limitations and untested behavior

- Docker builds cannot reach the internet from inside containers in this cloud environment, so local Compose checks use host-built images; the real Dockerfiles are verified only in CI.
- Only Chromium is available locally; Firefox, WebKit, and iPhone-profile checks start in CI with Phase 1.
- coturn's TLS listener is not configured (Phase 8). Its shared secret is passed on the command line in dev and CI; production uses a mounted configuration (Phase 9).
- The web container's CSP still allows inline styles and Caddy runs as root; tightened in Phase 1.

## 7. Backlog

| Priority | Item |
|---|---|
| P0 | Import the Claude Design handoff into `design/claude-design/` |
| P0 | Replace provisional tokens; write `docs/DESIGN_SYSTEM.md`; extend the screen map; export brand assets; generate i18n catalogs |
| P0 | QA round 2 and a green CI run on the final Phase 0 commit |
| P1 | Web CSP without inline styles, extra security headers, non-root web container (Phase 1) |
| P2 | Pin actions by SHA; avoid duplicate push and PR runs (Phase 9) |

## 8. Local run instructions

See the README: `cp .env.example .env`, then `docker compose up --build`, then open <https://localhost:8443>.

## 9. Commits

| Commit | Summary |
|---|---|
| bf9ce04 | Claude Design handoff recorded as the UI source of truth; qa-reviewer agent; markdown lint fixes |
| 303721f | Phase 0 scaffolds, Compose, CI, ADRs |
| 1652d6a | Go 1.25 build image and Trivy invocation (superseded) |
| 754b7f4 | QA round 1 fixes: Go 1.27, audit clean, gitleaks, redaction, middleware, lint guard, CI hygiene |
