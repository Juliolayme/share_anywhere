# ADR 0007: Database migrations with goose

Status: Accepted (Phase 1, 2026-11-10)

## Context

`CLAUDE.md` §5 leaves the choice between `golang-migrate` and `goose` to Phase 1. The backend is one Go binary shipped in a distroless image with no shell, so migrations must run from inside the binary, against the pgx pool we already open, from files that are part of the build.

## Decision

- Use **goose v3** (`github.com/pressly/goose/v3` v3.29.0) through its `Provider` API, with SQL files only (`-- +goose Up` / `-- +goose Down`).
- Migrations live in `backend/migrations/NNNN_name.sql` and are embedded into the binary with `//go:embed` (`backend/migrations/embed.go`).
- `SA_MIGRATE_ON_START=true` applies pending migrations at startup (`internal/platform/db.Migrate`). Compose stacks set it. Production can set it too, or run the binary once before rolling out more instances; goose takes a PostgreSQL advisory lock, so concurrent starts cannot apply a migration twice.
- Every migration is forward-compatible with the previous release (add columns nullable or with defaults, drop in a later release), so a rollback of the binary never needs a down migration.

## Alternatives

- `golang-migrate`: equally capable, but its embedded-FS driver and pgx v5 driver are separate modules and its CLI-first design adds a second binary to the image.

## Consequences

- The integration test (`internal/devices/pgstore_test.go`) applies the embedded migrations to a fresh schema in `TEST_DATABASE_URL` and checks that a second run applies nothing.
- The goose version table is `goose_db_version` in the application schema.
