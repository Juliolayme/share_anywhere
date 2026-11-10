-- +goose Up
-- How the device receives its refresh secret, fixed at creation (docs/ADR/0008-device-token-format.md):
-- "cookie" (Web, HttpOnly sa_device cookie only) or "body" (native apps, Keystore/Keychain). Refresh and
-- reset always answer the same way, so a Web secret can never be moved into a readable response body.
ALTER TABLE devices
    ADD COLUMN refresh_transport text NOT NULL DEFAULT 'cookie' CHECK (refresh_transport IN ('cookie', 'body'));

-- +goose Down
ALTER TABLE devices DROP COLUMN refresh_transport;
