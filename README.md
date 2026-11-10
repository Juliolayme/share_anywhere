# Share Anywhere

Cross-platform peer-to-peer file sharing and clipboard sync for Web, Android, and iOS. File sharing is guest-first: no account is needed to send or receive. Only Clipboard Sync and a few account-wide features require signing in.

Status: **Phase 0 (foundation) in progress.** No product feature is usable yet. See `docs/phases/README.md` for the plan and `docs/phases/reports/` for what has actually been built and tested.

## Where things are

| Path | What |
|---|---|
| `CLAUDE.md` | Standing engineering rules |
| `CLAUDE_DESIGN_AND_BUILD_PROMPT.md` | How to run a phase, document map |
| `design/claude-design/` | Claude Design handoff, the UI source of truth (imported in Phase 0) |
| `docs/` | Requirements, architecture, screen map, security model, API, testing strategy, ADRs, phase plans and reports |
| `backend/` | Go backend (modular monolith) |
| `web/` | React + TypeScript web app |
| `shared/design/tokens.json` | Design tokens; `pnpm tokens` generates platform files |
| `infra/` | coturn and Caddy configuration |

## Quick start (Docker Compose)

Requirements: Docker with Compose v2.

```bash
cp .env.example .env
```

```bash
docker compose up --build
```

Then open <https://localhost:8443> and accept the local certificate (Caddy's internal CA). Health checks: `https://localhost:8443/healthz` and `https://localhost:8443/readyz`.

## Local development without Docker

Requirements: Go 1.27, Node 22, pnpm 10.28 (`npm install -g pnpm@10.28.0`), and optionally PostgreSQL 16.

```bash
pnpm install
```

```bash
cd backend && go run ./cmd/server
```

```bash
pnpm --filter @share-anywhere/web dev
```

The web dev server runs on <http://localhost:5173> and proxies `/v1`, `/healthz`, and `/readyz` to the backend on port 8080. The brand and token preview is at <http://localhost:5173/brand> in development builds only.

## Checks

```bash
pnpm tokens:check && pnpm test:scripts && pnpm lint:md
```

```bash
cd backend && go vet ./... && golangci-lint run ./... && go test -race ./...
```

```bash
pnpm --filter @share-anywhere/web format:check && pnpm --filter @share-anywhere/web lint && pnpm --filter @share-anywhere/web typecheck && pnpm --filter @share-anywhere/web test && pnpm --filter @share-anywhere/web build
```

CI runs the same checks plus secret scanning, vulnerability scanning, image builds, and a Compose smoke test (`.github/workflows/ci.yml`).
