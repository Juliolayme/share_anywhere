-- +goose Up
-- Phase 5A QA round 2 (docs/ADR/0014-current-version-proofs.md): an ADK rotation is owed once an added device
-- that held a registered (proven) wrapping key leaves the account by any path. Set in the same transaction as
-- the departure (backend/internal/auth/sessions.go detach), cleared by the next successful rotation, and
-- reported in GET /v1/keys so a ready client rotates on its next key check.
ALTER TABLE account_keys ADD COLUMN rotation_due boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE account_keys DROP COLUMN rotation_due;
