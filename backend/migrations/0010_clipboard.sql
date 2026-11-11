-- +goose Up
-- Clipboard Sync v1 (Phase 5B; docs/ARCHITECTURE.md §8, docs/API.md §2.5, docs/CLIPBOARD_PROTOCOL.md). The server
-- stores AES-256-GCM ciphertext under the ADK's clipboard-v1 subkey, never plaintext.

-- Per account: the clipboard settings (defaults when no row exists: not paused, 7-day retention, skip sensitive
-- clips) and last_seq, the highest clipboard seq ever assigned. seq comes from this counter, not from
-- MAX(clipboard_events.seq), because the retention sweep hard-deletes rows: a sequence derived from the
-- remaining rows could hand out a seq that a device cursor has already passed.
CREATE TABLE clipboard_settings (
    user_id        uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    paused         boolean     NOT NULL DEFAULT false,
    retention_days integer     NOT NULL DEFAULT 7 CHECK (retention_days BETWEEN 1 AND 7),
    sensitive_skip boolean     NOT NULL DEFAULT true,
    last_seq       bigint      NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at     timestamptz NOT NULL
);

-- One immutable event per capture. seq is strictly increasing per user, assigned under a per-user advisory lock
-- (pg_advisory_xact_lock(2, hashtext(user_id))) so seq order equals commit order. A deletion becomes a tombstone
-- (no nonce, no ciphertext) with a new seq. origin_device_id has no foreign key: events outlive purged devices.
CREATE TABLE clipboard_events (
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    event_id         uuid        NOT NULL,
    seq              bigint      NOT NULL CHECK (seq >= 1),
    origin_device_id uuid        NOT NULL,
    event_type       text        NOT NULL CHECK (event_type = 'TEXT'),
    mime_type        text        NOT NULL CHECK (mime_type = 'text/plain'),
    key_version      integer     NOT NULL CHECK (key_version >= 1),
    nonce            bytea       NULL CHECK (octet_length(nonce) = 12),
    ciphertext       bytea       NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 262160),
    payload_size     integer     NOT NULL CHECK (payload_size BETWEEN 1 AND 262144),
    created_at       timestamptz NOT NULL,
    expires_at       timestamptz NOT NULL,
    deleted_at       timestamptz NULL,
    PRIMARY KEY (user_id, event_id),
    UNIQUE (user_id, seq),
    CHECK ((deleted_at IS NULL) = (ciphertext IS NOT NULL AND nonce IS NOT NULL))
);

-- Live events by time: history (newest first), the 100-item cap (oldest first), and the retention sweep.
CREATE INDEX clipboard_events_live_idx ON clipboard_events (user_id, seq) WHERE deleted_at IS NULL;
CREATE INDEX clipboard_events_expiry_idx ON clipboard_events (expires_at) WHERE deleted_at IS NULL;
CREATE INDEX clipboard_events_tombstone_idx ON clipboard_events (deleted_at) WHERE deleted_at IS NOT NULL;

-- Per device: the cursor (seq) it last reported as applied. Deleted when the device leaves the account.
CREATE TABLE clipboard_device_cursors (
    device_id  uuid        PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    last_seq   bigint      NOT NULL CHECK (last_seq >= 0),
    updated_at timestamptz NOT NULL
);

CREATE INDEX clipboard_device_cursors_user_idx ON clipboard_device_cursors (user_id);

-- +goose Down
DROP TABLE clipboard_device_cursors;
DROP TABLE clipboard_events;
DROP TABLE clipboard_settings;
