-- Cloud Distribution (Phase 8, docs/ARCHITECTURE.md §6 and §8, docs/ADR/0030-cloud-distribution.md): signed-in
-- senders only, explicit consent, a monthly byte budget, TTL and deletion after delivery. Objects hold client-side
-- ciphertext in the object store, one stored object per part; these tables keep only metadata.

-- +goose Up
CREATE TABLE cloud_settings (
    user_id      uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    enabled      boolean     NOT NULL DEFAULT false,
    consented_at timestamptz NULL,
    budget_bytes bigint      NOT NULL CHECK (budget_bytes >= 0),
    updated_at   timestamptz NOT NULL,
    CHECK (NOT enabled OR consented_at IS NOT NULL)
);

-- Bytes uploaded plus bytes downloaded per account and calendar month (UTC), against budget_bytes.
CREATE TABLE cloud_usage (
    user_id uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    period  date   NOT NULL,
    bytes   bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    PRIMARY KEY (user_id, period)
);

CREATE TABLE cloud_objects (
    id              uuid        PRIMARY KEY,
    session_id      uuid        NOT NULL REFERENCES share_sessions (id) ON DELETE CASCADE,
    file_id         uuid        NOT NULL REFERENCES shared_files (id) ON DELETE CASCADE,
    owner_user_id   uuid        NOT NULL,
    owner_device_id uuid        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('UPLOADING', 'READY', 'DELETED')),
    paused          boolean     NOT NULL DEFAULT false,
    size            bigint      NOT NULL CHECK (size >= 0),
    part_size       integer     NOT NULL CHECK (part_size > 0),
    part_count      integer     NOT NULL CHECK (part_count > 0),
    created_at      timestamptz NOT NULL,
    expires_at      timestamptz NOT NULL,
    sealed_at       timestamptz NULL,
    deleted_at      timestamptz NULL
);
-- One live object per shared file.
CREATE UNIQUE INDEX cloud_objects_file_live ON cloud_objects (file_id) WHERE status <> 'DELETED';
CREATE INDEX cloud_objects_session ON cloud_objects (session_id);
CREATE INDEX cloud_objects_sweep ON cloud_objects (expires_at) WHERE status <> 'DELETED';

CREATE TABLE cloud_object_parts (
    object_id uuid    NOT NULL REFERENCES cloud_objects (id) ON DELETE CASCADE,
    part      integer NOT NULL CHECK (part >= 0),
    bytes     integer NOT NULL CHECK (bytes > 0),
    PRIMARY KEY (object_id, part)
);

-- Receivers that finished downloading an object; the object is deleted once every joined receiver has.
CREATE TABLE cloud_receipts (
    object_id      uuid        NOT NULL REFERENCES cloud_objects (id) ON DELETE CASCADE,
    participant_id uuid        NOT NULL,
    received_at    timestamptz NOT NULL,
    PRIMARY KEY (object_id, participant_id)
);

-- +goose Down
DROP TABLE cloud_receipts;
DROP TABLE cloud_object_parts;
DROP TABLE cloud_objects;
DROP TABLE cloud_usage;
DROP TABLE cloud_settings;
