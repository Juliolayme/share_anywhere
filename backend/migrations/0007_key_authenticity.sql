-- +goose Up
-- Phase 5A QA round 1: key authenticity (docs/ADR/0012-key-authenticity.md) and account session hardening
-- (docs/ADR/0013-session-hardening.md).

-- Recovery anchor: HMAC of verify_key(1) under a key derived from the recovery phrase, so a phrase holder can
-- authenticate the version list without trusting the server. NULL for accounts set up before this migration
-- (legacy: rotation and device-key registration answer 409 keys_legacy).
ALTER TABLE account_keys ADD COLUMN recovery_anchor bytea NULL CHECK (octet_length(recovery_anchor) = 32);

-- Per version: the Ed25519 verify key derived from ADK(v), and the signature by version v-1 that authorized
-- it (NULL for version 1 and for legacy rows).
ALTER TABLE account_key_versions
    ADD COLUMN verify_key bytea NULL CHECK (octet_length(verify_key) = 32),
    ADD COLUMN signature  bytea NULL CHECK (octet_length(signature) = 64);

-- Device wrapping keys must be proven by a signature of an ADK version the device holds. Existing rows carry
-- no proof (pre-release data): they are deleted, and each device registers again once it holds the ADK.
DELETE FROM device_keys;
ALTER TABLE device_keys
    ADD COLUMN key_version integer NOT NULL CHECK (key_version >= 1),
    ADD COLUMN proof       bytea   NOT NULL CHECK (octet_length(proof) = 64);

-- Browser-session binding of a not-added Web account session: SHA-256 of the sa_acct cookie (no Max-Age, so
-- it ends with the browser session). NULL for added sessions and for native (body transport) devices.
ALTER TABLE auth_sessions ADD COLUMN browser_binding bytea NULL CHECK (octet_length(browser_binding) = 32);

-- A refresh secret retired by the reuse-grace path never qualifies for grace itself: presenting it is reuse.
ALTER TABLE device_refresh_secrets ADD COLUMN retired boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE device_refresh_secrets DROP COLUMN retired;
ALTER TABLE auth_sessions DROP COLUMN browser_binding;
ALTER TABLE device_keys DROP COLUMN proof, DROP COLUMN key_version;
ALTER TABLE account_key_versions DROP COLUMN signature, DROP COLUMN verify_key;
ALTER TABLE account_keys DROP COLUMN recovery_anchor;
