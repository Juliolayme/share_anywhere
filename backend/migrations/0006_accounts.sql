-- +goose Up
-- Accounts layered on device identity, account keys (wrapped ADK only), pairing, and encrypted cloud history
-- (Phase 5A; docs/ARCHITECTURE.md §8, docs/SECURITY_MODEL.md §4, §7). The server stores password hashes,
-- hashed reset tokens and pairing codes, public keys, and opaque wrapped-key and ciphertext blobs; never a
-- plaintext key or history entry.

-- Emails are stored lowercased (checked) and unique; citext would need a database-wide extension.
CREATE TABLE users (
    id                  uuid        PRIMARY KEY,
    email               text        NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
    password_hash       text        NOT NULL,
    history_sync        boolean     NOT NULL DEFAULT false,
    -- No email verification in v1 (PRD §2); the column keeps the structure present.
    email_verified_at   timestamptz NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    password_changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (email);

-- devices.kind = 'account' and devices.user_id are set while the device is added to an account
-- (CHECK in 0001); sign-out, revoke, reset, and password reset return it to 'anonymous'.
ALTER TABLE devices ADD CONSTRAINT devices_user_fk FOREIGN KEY (user_id) REFERENCES users (id);
CREATE INDEX devices_user_idx ON devices (user_id) WHERE user_id IS NOT NULL;

-- One account session per device at a time, layered on the device identity. device_added = false sessions
-- end at most 24 h after sign-in; added sessions slide to 90 days after last use.
CREATE TABLE auth_sessions (
    id           uuid        PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id    uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    device_added boolean     NOT NULL,
    created_at   timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz NULL
);

CREATE UNIQUE INDEX auth_sessions_device_active_key ON auth_sessions (device_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- Reset tokens are 256-bit, stored as SHA-256, single use, 30 minutes.
CREATE TABLE password_resets (
    token_hash bytea       PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz NULL
);

CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- Per account: the current ADK version (0 = no ADK yet) and the recovery public key with its Argon2id salt
-- and parameters. The row is created with the user and locked (FOR UPDATE) by setup and rotation.
CREATE TABLE account_keys (
    user_id             uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    key_version         integer     NOT NULL DEFAULT 0 CHECK (key_version >= 0),
    recovery_public_key bytea       NULL CHECK (octet_length(recovery_public_key) = 32),
    recovery_salt       bytea       NULL,
    recovery_m          integer     NULL,
    recovery_t          integer     NULL,
    recovery_p          integer     NULL,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Per ADK version: the ADK wrapped to the recovery public key, and the chain blob (ADK(v-1) wrapped with
-- ADK(v)); version 1 has no chain blob.
CREATE TABLE account_key_versions (
    user_id              uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key_version          integer     NOT NULL CHECK (key_version >= 1),
    recovery_blob        bytea       NOT NULL,
    chain_blob           bytea       NULL,
    created_by_device_id uuid        NOT NULL,
    created_at           timestamptz NOT NULL,
    PRIMARY KEY (user_id, key_version),
    CHECK ((key_version = 1) = (chain_blob IS NULL))
);

-- Each added device's X25519 wrapping public key; removed when the device leaves the account.
CREATE TABLE device_keys (
    device_id  uuid        PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    public_key bytea       NOT NULL CHECK (octet_length(public_key) = 32),
    created_at timestamptz NOT NULL
);

CREATE INDEX device_keys_user_idx ON device_keys (user_id);

-- ADK versions wrapped for one device by a rotation, until that device acknowledges them.
CREATE TABLE device_key_blobs (
    device_id      uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    key_version    integer     NOT NULL,
    user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blob           bytea       NOT NULL,
    from_device_id uuid        NOT NULL,
    created_at     timestamptz NOT NULL,
    PRIMARY KEY (device_id, key_version)
);

-- New device ↔ existing device pairing (PRD §7.5): one pairing per new device; the code is 128-bit and
-- stored as SHA-256; the wrapped ADK is picked up once.
CREATE TABLE device_pairings (
    id                   uuid        PRIMARY KEY,
    user_id              uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    new_device_id        uuid        NOT NULL UNIQUE REFERENCES devices (id) ON DELETE CASCADE,
    ephemeral_public_key bytea       NOT NULL CHECK (octet_length(ephemeral_public_key) = 32),
    code_hash            bytea       NOT NULL UNIQUE,
    created_at           timestamptz NOT NULL,
    expires_at           timestamptz NOT NULL,
    key_version          integer     NULL,
    sender_public_key    bytea       NULL,
    blob                 bytea       NULL,
    wrapped_by_device_id uuid        NULL,
    wrapped_at           timestamptz NULL,
    consumed_at          timestamptz NULL
);

CREATE INDEX device_pairings_expiry_idx ON device_pairings (expires_at);

-- Encrypted cloud history. seq is strictly increasing per user, assigned under a per-user advisory lock so
-- seq order equals commit order; a deletion becomes a tombstone (no nonce, no ciphertext) with a new seq.
-- origin_device_id has no foreign key: history outlives purged device rows.
CREATE TABLE history_entries (
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    entry_id         uuid        NOT NULL,
    seq              bigint      NOT NULL,
    origin_device_id uuid        NOT NULL,
    key_version      integer     NOT NULL CHECK (key_version >= 1),
    nonce            bytea       NULL,
    ciphertext       bytea       NULL,
    created_at       timestamptz NOT NULL,
    deleted_at       timestamptz NULL,
    PRIMARY KEY (user_id, entry_id),
    UNIQUE (user_id, seq),
    CHECK ((deleted_at IS NULL) = (ciphertext IS NOT NULL AND nonce IS NOT NULL))
);

-- +goose Down
DROP TABLE history_entries;
DROP TABLE device_pairings;
DROP TABLE device_key_blobs;
DROP TABLE device_keys;
DROP TABLE account_key_versions;
DROP TABLE account_keys;
DROP TABLE password_resets;
DROP TABLE auth_sessions;
DROP INDEX devices_user_idx;
ALTER TABLE devices DROP CONSTRAINT devices_user_fk;
DROP TABLE users;
