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

0. Import the Claude Design handoff into `design/claude-design/` with the exported file names unchanged (`CLAUDE.md`, UI source of truth). Every design-dependent deliverable below (tokens, logo, brand assets, design system doc, screen map IDs, i18n catalogs) is derived from those files, not invented.
1. `docs/phases/reports/PHASE_0_REPORT.md` section "Inventory": branch, files, installed versions of Go, Node, pnpm, JDK, Android SDK (or "not available"), Docker.
2. `docs/ADR/0001-monorepo-and-toolchain.md`, `0002-guest-first-identity-model.md` (anonymous device identity, account layering, account-only features, Cloud requires a signed-in sender), `0003-client-owned-route-strategy.md`, `0004-clipboard-key-bootstrap.md`, `0005-browser-capability-policy.md`, `0006-android-sdk-and-fgs-limits.md`. Each records context, decision, consequences, referencing PRD §2.
3. `shared/design/tokens.json` carrying the token values from `design/claude-design/Design System.dc.html`, as the single machine-readable source for code, with `scripts/gen-tokens.mjs` emitting CSS variables for Web now and leaving documented hooks for Kotlin and Swift generation in Phases 6 and 7.
4. `docs/DESIGN_SYSTEM.md`: components must include the identity chip (Guest / account), Guest and Signed in badges, security words, the participant row with Remove and Block, the Require approval toggle, the keep-screen-on status row, and the account-required intro (PRD §9); tokens (color incl. dark theme, type scale, spacing 4-pt, radii, elevation, borders), component inventory with states, breakpoints (`sm 640, md 768, lg 1024, xl 1280`), form validation patterns, accessibility rules, brand guide (clear space, min size, incorrect use).
5. Extend the existing `docs/UX_SCREEN_MAP.md` (do not recreate it): add the design-system component used on each screen and a per-screen state model, and keep its Guest / Signed in columns, first-launch path, and account CTA list intact. Review `docs/ARCHITECTURE.md`, `docs/SECURITY_MODEL.md`, and `docs/API.md` and record in ADRs any change you need.
6. Brand assets in `web/public/brand/` (SVG sources, PNG exports 16–512 px, favicon.ico, `site.webmanifest` icons) `android/app/src/main/res/mipmap-*` adaptive icon foreground/background/monochrome layers, and `ios/ShareAnywhere/Assets.xcassets/AppIcon.appiconset` (1024 px plus light/dark/tinted variants) with a `Contents.json`. The `ios/` folder holds only brand assets at this phase; the Xcode project arrives in Phase 7. The logo comes from `design/claude-design/Logo.dc.html` and `Brand.dc.html` (extract the SVG; do not redraw a different mark). Raster exports via `resvg` or `sharp` in `scripts/export-brand.mjs`.
6b. `shared/i18n/` with EN and VI catalogs generated from `design/claude-design/i18n-strings.json` by a script, plus a check that the generated catalogs are current.
7. `web/` scaffold: Vite + React + TS strict + Tailwind with tokens as CSS variables and Tailwind theme extension; `/brand` preview route (dev only); Storybook optional.
8. `backend/` scaffold: `cmd/server` with config loading, structured logging with redaction, `/healthz`, `/readyz`, graceful shutdown; `internal/platform` only.
9. `docker-compose.yml` with `postgres:16`, `coturn/coturn` using `infra/coturn/turnserver.conf` with `use-auth-secret`, `caddy` with local TLS (`infra/caddy/Caddyfile`); `docker-compose.ci.yml` variant without TLS termination quirks.
10. `.env.example`, `.nvmrc`, `.editorconfig`, `.gitignore`, `README.md` quick start.
11. `.github/workflows/ci.yml` with `docs`, `security`, `backend`, `web`, `protocol` jobs and path filters; `nightly.yml` stub with schedule and a no-op job documenting what will be added.

## Tests to add

- `backend`: health handler test.
- `web`: token snapshot test (CSS variables exist for every token), `/brand` renders.

## CI changes

First version of `ci.yml` and `nightly.yml`. All jobs must pass on this phase's final commit.

## Exit gate

`ci.yml` green on the phase branch; `docker compose up` starts all services; `/brand` page renders in both themes; report written.

## Report

Per `CLAUDE.md` §9. Include a screenshot of the brand preview and the exact versions pinned.
