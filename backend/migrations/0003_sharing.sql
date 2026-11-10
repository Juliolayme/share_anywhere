-- +goose Up
-- Share sessions, participants, blocks, files, capability tokens, transfers (docs/ARCHITECTURE.md §4, §8;
-- docs/SECURITY_MODEL.md §3, §6). Sessions belong to a device; owner_user_id stays NULL until Phase 5A.
CREATE TABLE share_sessions (
    id                    uuid        PRIMARY KEY,
    owner_device_id       uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    owner_user_id         uuid        NULL,
    status                text        NOT NULL CHECK (status IN ('WAITING', 'ACTIVE', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CLOSED', 'EXPIRED', 'CANCELLED')),
    require_approval      boolean     NOT NULL DEFAULT false,
    join_window_state     text        NOT NULL CHECK (join_window_state IN ('OPEN', 'EXPIRED', 'ENDED_FULL', 'ENDED_BY_SENDER')),
    join_window_seq       integer     NOT NULL DEFAULT 1,
    join_window_opened_at timestamptz NOT NULL,
    join_window_ends_at   timestamptz NOT NULL,
    code_hmac             bytea       NOT NULL,
    -- The code and link token encrypted with a server key (AES-256-GCM), so only the sender can see them
    -- again after a reload; lookups use code_hmac and the capability token hash.
    code_enc              bytea       NOT NULL,
    link_enc              bytea       NOT NULL,
    created_at            timestamptz NOT NULL,
    last_activity_at      timestamptz NOT NULL,
    expires_at            timestamptz NOT NULL,
    ended_at              timestamptz NULL,
    purge_after           timestamptz NULL
);
-- A six-digit code is unique among open join windows; it may be reissued after its window ends.
CREATE UNIQUE INDEX share_sessions_open_code_idx ON share_sessions (code_hmac) WHERE join_window_state = 'OPEN';
CREATE INDEX share_sessions_code_idx ON share_sessions (code_hmac, join_window_opened_at DESC);
CREATE INDEX share_sessions_owner_idx ON share_sessions (owner_device_id, status);
CREATE INDEX share_sessions_window_idx ON share_sessions (join_window_ends_at) WHERE join_window_state = 'OPEN';

CREATE TABLE session_participants (
    id             uuid        PRIMARY KEY,
    session_id     uuid        NOT NULL REFERENCES share_sessions (id) ON DELETE CASCADE,
    device_id      uuid        NOT NULL,
    user_id        uuid        NULL,
    role           text        NOT NULL CHECK (role IN ('sender', 'receiver')),
    status         text        NOT NULL CHECK (status IN ('REQUESTED', 'JOINED', 'LEFT', 'REMOVED', 'BLOCKED', 'REJECTED')),
    display_name   text        NOT NULL,
    platform       text        NOT NULL,
    signed_in      boolean     NOT NULL DEFAULT false,
    security_words text        NULL,
    joined_via     text        NULL CHECK (joined_via IN ('code', 'link')),
    request_reason text        NULL CHECK (request_reason IN ('approval', 'protected_mode')),
    ip_key         text        NULL,
    created_at     timestamptz NOT NULL,
    joined_at      timestamptz NULL,
    decided_at     timestamptz NULL,
    UNIQUE (session_id, device_id)
);
CREATE INDEX session_participants_device_idx ON session_participants (device_id);

CREATE TABLE session_blocks (
    session_id uuid        NOT NULL REFERENCES share_sessions (id) ON DELETE CASCADE,
    device_id  uuid        NULL,
    ip_key     text        NULL,
    created_at timestamptz NOT NULL,
    CHECK (device_id IS NOT NULL OR ip_key IS NOT NULL)
);
CREATE INDEX session_blocks_session_idx ON session_blocks (session_id);

CREATE TABLE shared_files (
    id         uuid    PRIMARY KEY,
    session_id uuid    NOT NULL REFERENCES share_sessions (id) ON DELETE CASCADE,
    position   integer NOT NULL,
    name       text    NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
    size       bigint  NOT NULL CHECK (size >= 0),
    mime       text    NOT NULL DEFAULT '',
    UNIQUE (session_id, position)
);

-- Link/QR join tokens (purpose join) and single-use join tickets (purpose join_ticket), hashed at rest.
CREATE TABLE capability_tokens (
    token_hash     bytea       PRIMARY KEY,
    session_id     uuid        NOT NULL REFERENCES share_sessions (id) ON DELETE CASCADE,
    participant_id uuid        NULL,
    purpose        text        NOT NULL CHECK (purpose IN ('join', 'join_ticket', 'transfer')),
    window_seq     integer     NOT NULL,
    via            text        NULL CHECK (via IN ('code', 'link')),
    device_id      uuid        NULL,
    created_at     timestamptz NOT NULL,
    expires_at     timestamptz NOT NULL,
    used_at        timestamptz NULL,
    revoked_at     timestamptz NULL
);
CREATE INDEX capability_tokens_session_idx ON capability_tokens (session_id, purpose);

CREATE TABLE transfers (
    id             uuid        PRIMARY KEY,
    session_id     uuid        NOT NULL REFERENCES share_sessions (id) ON DELETE CASCADE,
    participant_id uuid        NOT NULL REFERENCES session_participants (id) ON DELETE CASCADE,
    file_id        uuid        NOT NULL REFERENCES shared_files (id) ON DELETE CASCADE,
    status         text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONNECTING', 'TRANSFERRING', 'PAUSED', 'DISCONNECTED', 'RECONNECTING', 'RESUMING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    verified_bytes bigint      NOT NULL DEFAULT 0,
    route          text        NULL,
    updated_at     timestamptz NOT NULL,
    UNIQUE (participant_id, file_id)
);

CREATE TABLE session_events (
    id         bigserial   PRIMARY KEY,
    session_id uuid        NOT NULL REFERENCES share_sessions (id) ON DELETE CASCADE,
    type       text        NOT NULL,
    data       jsonb       NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL
);
CREATE INDEX session_events_session_idx ON session_events (session_id, id);

-- +goose Down
DROP TABLE session_events;
DROP TABLE transfers;
DROP TABLE capability_tokens;
DROP TABLE shared_files;
DROP TABLE session_blocks;
DROP TABLE session_participants;
DROP TABLE share_sessions;
