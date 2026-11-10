-- +goose Up
-- Anonymous device identity (docs/SECURITY_MODEL.md §4, docs/ARCHITECTURE.md §8).
CREATE TABLE devices (
    id                 uuid PRIMARY KEY,
    kind               text        NOT NULL DEFAULT 'anonymous' CHECK (kind IN ('anonymous', 'account')),
    user_id            uuid        NULL,
    display_name       text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
    platform           text        NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 60),
    refresh_generation integer     NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz NULL,
    CHECK ((kind = 'account') = (user_id IS NOT NULL))
);

CREATE INDEX devices_purge_idx ON devices (kind, last_seen_at);

-- Every refresh secret ever issued, stored only as a SHA-256 hash. A used row presented again is a reuse
-- and revokes the device.
CREATE TABLE device_refresh_secrets (
    secret_hash bytea       PRIMARY KEY,
    device_id   uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    generation  integer     NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    used_at     timestamptz NULL
);

CREATE INDEX device_refresh_secrets_device_idx ON device_refresh_secrets (device_id);

-- +goose Down
DROP TABLE device_refresh_secrets;
DROP TABLE devices;
