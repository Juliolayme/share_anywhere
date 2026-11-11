-- +goose Up
-- Phase 5A QA round 3 (docs/ADR/0015-authenticated-recovery-key.md): the recovery public key is signed at setup with
-- the signing key of ADK version 1 over "sa-recoverykey-v1|" + b64u(recovery_public_key), so a rotating device can
-- check it with its own verify_key(1) before wrapping a new ADK to it. NULL for accounts set up before this
-- migration (legacy: clients refuse to rotate with keys_legacy).
ALTER TABLE account_keys ADD COLUMN recovery_key_signature bytea NULL CHECK (octet_length(recovery_key_signature) = 64);

-- +goose Down
ALTER TABLE account_keys DROP COLUMN recovery_key_signature;
