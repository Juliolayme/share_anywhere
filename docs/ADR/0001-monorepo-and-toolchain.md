# ADR 0001: Monorepo layout and toolchain pins

Status: Accepted (Phase 0, 2026-11-10)

## Context

Share Anywhere ships a Go backend, a React web app, a native Android app, and a native iOS app that share one protocol, one set of design tokens, and one set of strings (PRD §2, `CLAUDE.md` §5 and §6). Versions must be reproducible in CI and in the cloud development environment.

## Decision

- One repository with `backend/`, `web/`, `android/`, `ios/`, `shared/`, `infra/`, `scripts/`, `docs/`, and the Claude Design handoff in `design/claude-design/`.
- pnpm workspace at the root (`pnpm@10.28.0` pinned through `packageManager`); exact versions in every `package.json` (`.npmrc` `save-exact=true`) and a committed `pnpm-lock.yaml`.
- Versions verified in the Phase 0 environment and pinned:

| Tool | Pinned | Where |
|---|---|---|
| Go | 1.27 with `toolchain go1.27.3`, the latest stable release (1.25 is out of support and govulncheck reported 20 reachable stdlib vulnerabilities on it). The environment's go1.24.7 auto-downloads the toolchain | `backend/go.mod`, CI `setup-go` reads it, `golang:1.27-alpine` build image |
| golangci-lint | v2.15.0 (built with Go 1.27) | CI |
| govulncheck | v1.9.0 | CI |
| Node | 22 LTS (environment: v22.23.4) | `.nvmrc`, `engines` |
| pnpm | 10.28.0 | `packageManager` |
| React | 18.3.1 | `web/package.json` |
| Vite / Vitest / TypeScript | 6.4.x / 5.1.0 / 5.8.x (exact in lockfile) | `web/package.json` |
| React Router | 7.x (6.x had open advisories) | `web/package.json` |
| Tailwind CSS | 3.4.x | `web/package.json` |
| PostgreSQL | 16 (`postgres:16-alpine`) | Compose, CI services |
| coturn | 4.6 | Compose |
| Caddy | 2 (`caddy:2-alpine`) | Compose |
| JDK for Android | 17 in CI (environment has 21; AGP 8 accepts both) | Phase 6 |
| Android SDK | not available in the environment; CI installs it | Phase 6 |
| Xcode | not available in the environment; macOS runner | Phase 7 |

- Backend container images are built from `golang:1.27-alpine` into `distroless/static:nonroot`; the binary has a `-healthcheck` flag because distroless has no shell or curl.

## Consequences

- Tool upgrades are deliberate: change the pin, the lockfile, and this table together.
- Android and iOS claims can only be verified in CI (emulator and simulator), which `docs/TESTING_AND_CI.md` already requires.
- The cloud environment's outbound proxy does not reach inside Docker builds, so local `docker compose` verification builds artifacts on the host; the real Dockerfiles are verified by the `compose`, `backend`, `web`, and `security` CI jobs.
