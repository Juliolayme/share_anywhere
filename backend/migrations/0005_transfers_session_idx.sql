-- +goose Up
-- The session aggregate (docs/ARCHITECTURE.md §4.5) and the maintenance job read a session's transfers by
-- session and status; without this index each read scans the whole transfers table.
CREATE INDEX transfers_session_status_idx ON transfers (session_id, status);

-- +goose Down
DROP INDEX transfers_session_status_idx;
