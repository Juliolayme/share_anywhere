-- +goose Up
-- Client addresses are never stored (docs/SECURITY_MODEL.md §8). Participants and blocks keep only a keyed
-- hash (HMAC-SHA-256 with the server secret) of the IPv4 address or IPv6 /64, which is enough to match a
-- Block. Values written by 0003 held raw keys; they are dropped (device-ID blocks are unaffected).
ALTER TABLE session_participants RENAME COLUMN ip_key TO ip_hash;
UPDATE session_participants SET ip_hash = NULL;
ALTER TABLE session_blocks RENAME COLUMN ip_key TO ip_hash;
DELETE FROM session_blocks WHERE device_id IS NULL;
UPDATE session_blocks SET ip_hash = NULL;

-- +goose Down
ALTER TABLE session_blocks RENAME COLUMN ip_hash TO ip_key;
ALTER TABLE session_participants RENAME COLUMN ip_hash TO ip_key;
