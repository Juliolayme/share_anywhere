# Phase 0 — Foundation, design system, brand, CI skeleton

Read: `CLAUDE.md`, PRD §2, §3, §9, §10; `docs/TESTING_AND_CI.md` §2.

## Scope
- Repository inventory and toolchain pinning.
- Architecture decision records for the fixed decisions.
- Design tokens, component inventory, screen map.
- Original brand assets.
- CI skeleton that is green before any product code exists.
- Docker Compose for local dependencies (postgres, coturn, caddy).

## Out of scope
Any product feature, auth, API endpoints beyond `/healthz`.

## Deliverables
1. `docs/phases/reports/PHASE_0_REPORT.md` section "Inventory": branch, files, installed versions of Go, Node, pnpm, JDK, Android SDK (or "not available"), Docker.
2. `docs/ADR/0001-monorepo-and-toolchain.md`, `0002-auth-model.md`, `0003-client-owned-route-strategy.md`, `0004-clipboard-key-bootstrap.md`, `0005-browser-capability-policy.md`, `0006-android-sdk-and-fgs-limits.md`. Each records context, decision, consequences, referencing PRD §2.
3. `docs/DESIGN_SYSTEM.md`: tokens (color incl. dark theme, type scale, spacing 4-pt, radii, elevation, borders), component inventory with states, breakpoints (`sm 640, md 768, lg 1024, xl 1280`), form validation patterns, accessibility rules, brand guide (clear space, min size, incorrect use).
4. `docs/UX_SCREEN_MAP.md`: every screen from PRD §5 with route/destination, entry points, states, and primary action.
5. Brand assets in `web/public/brand/` (SVG sources, PNG exports 16–512 px, favicon.ico, `site.webmanifest` icons) and `android/app/src/main/res/mipmap-*` adaptive icon foreground/background/monochrome layers. Use an editable SVG construction; raster exports via `resvg` or `sharp` in `scripts/export-brand.mjs`.
6. `web/` scaffold: Vite + React + TS strict + Tailwind with tokens as CSS variables and Tailwind theme extension; `/brand` preview route (dev only); Storybook optional.
7. `backend/` scaffold: `cmd/server` with config loading, structured logging with redaction, `/healthz`, `/readyz`, graceful shutdown; `internal/platform` only.
8. `docker-compose.yml` with `postgres:16`, `coturn/coturn` using `infra/coturn/turnserver.conf` with `use-auth-secret`, `caddy` with local TLS (`infra/caddy/Caddyfile`); `docker-compose.ci.yml` variant without TLS termination quirks.
9. `.env.example`, `.nvmrc`, `.editorconfig`, `.gitignore`, `README.md` quick start.
10. `.github/workflows/ci.yml` with `docs`, `security`, `backend`, `web`, `protocol` jobs and path filters; `nightly.yml` stub with schedule and a no-op job documenting what will be added.

## Tests to add
- `backend`: health handler test.
- `web`: token snapshot test (CSS variables exist for every token), `/brand` renders.

## CI changes
First version of `ci.yml` and `nightly.yml`. All jobs must pass on this phase's final commit.

## Exit gate
`ci.yml` green on the phase branch; `docker compose up` starts all services; `/brand` page renders in both themes; report written.

## Report
Per `CLAUDE.md` §9. Include a screenshot of the brand preview and the exact versions pinned.
