# API

Source of truth for the API surface and who may call each endpoint until `shared/protocol/openapi.yaml` exists. From Phase 1 onward, `openapi.yaml` is the machine-readable contract, every operation carries an `x-sa-access` extension matching the level in this file, and the `protocol` CI job fails if the two disagree. Security rationale lives in `docs/SECURITY_MODEL.md`; flows live in `docs/ARCHITECTURE.md`.

Status: **planned**. The phase that implements each group is noted in its heading.

---

## 1. Access levels

| Level | Meaning | Rejection |
|---|---|---|
| `public` | No token | — |
| `device` | Any valid device access token, guest or signed in | `401 device_token_invalid` or `401 device_token_expired` |
| `participant` | `device` + the device is the sender or a receiver participant of the session. Data and actions are further limited by role and state: a `REQUESTED` receiver (approval on) sees only the preview and its own status; file metadata, transfers, and TURN need `JOINED` | `404` (existence hidden) |
| `account` | Token with `acct` | `403 account_required` |
| `account+device` | Token with `acct` and `dl = true` | `403 device_not_added` |

A backend test generated from `openapi.yaml` calls every operation with no token, an expired token, a guest token, a signed-in not-added token, a signed-in added token, a non-participant device, a removed participant, and a revoked device, and asserts the outcome matches the level.

## 2. Endpoints

### 2.1 Health and identity (Phase 1)

| Endpoint | Level | Notes |
|---|---|---|
| `GET /healthz`, `GET /readyz` | public | |
| `GET /v1/devices/anonymous/challenge` | public | Proof-of-work parameters when the caller's IP is over the soft limit |
| `POST /v1/devices/anonymous` | public | Body: `platform`, `display_name`, optional PoW solution. Returns `device_id`, `access_token`, refresh secret (Web: set as cookie) |
| `POST /v1/devices/token` | public (refresh secret) | Rotates the secret; reuse (including a retired secret) revokes the device. Web requires `X-SA-Refresh: 1`, and a not-added Web account session also needs its `sa_acct` cookie (§2.4) |
| `GET /v1/devices/current`, `PATCH /v1/devices/current` | device | Display name, platform |
| `POST /v1/devices/current/reset` | device | New anonymous identity; ends this device's open sessions |
| `POST /v1/ws/ticket` | device | One-time ticket, 30 s |
| `GET /v1/ws?ticket=` | public (one-time ticket) | WebSocket upgrade. `Origin` must be an allowed origin (absent for native apps); the ticket is consumed on use. Limits in `docs/SECURITY_MODEL.md` §5 |

### 2.2 Share sessions and joining (Phase 2)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/sessions` | device | Body includes file metadata and `require_approval` (default `false`). Returns code, link token, QR payload (`join_url`), `join_window` (`state`, `opened_at`, `ends_at` = now + 10 min, `seq`), and `server_time` |
| `GET /v1/sessions` | device | The caller device's live sessions as sender (`WAITING`/`ACTIVE`, before the maximum lifetime), newest first, never with codes or links. Added in Phase 4 (as built below) |
| `GET /v1/sessions/{id}` | participant | Sender: full view. Joined receiver: full view. Requested receiver: preview and own status |
| `PATCH /v1/sessions/{id}` | participant (sender) | `require_approval` (future joins only); `accepting_receivers: false` = Stop accepting, which ends the join window now. Reopening is done only with `renew` |
| `POST /v1/sessions/{id}/close` | participant (sender) | |
| `POST /v1/sessions/{id}/renew` | participant (sender) | **Create new code**: new six-digit code, link token, and QR, fresh 10-minute join window, previous ones invalid at once. Returns the same fields as create. `409 session_full` while 5 receivers are in. Rate-limited |
| `POST /v1/sessions/resolve-code` | device | Body: six-digit code. Returns preview, `join_window_ends_at`, and a single-use join ticket valid 5 min but never past the window end. A code whose window ended is a failed lookup (`410 join_window_expired`). Counts toward code lookup and failed-lookup limits |
| `POST /v1/sessions/resolve-link` | device | Body: link/QR token. Returns preview, `join_window_ends_at`, and a join ticket; `410 join_window_expired` after the window |
| `POST /v1/sessions/{id}/join` | device | Body: join ticket. Returns participant with status `JOINED` (open join) or `REQUESTED` (approval on, or protected mode for code joins). `409 session_full`, `410 join_window_expired`, `410 session_not_accepting`, `403 blocked`. Already-joined receivers are never affected by the window |
| `POST /v1/participants/{id}/approve`, `POST /v1/participants/{id}/reject` | participant (sender) | Only for `REQUESTED` participants |
| `DELETE /v1/participants/{id}` | participant (sender) | Remove: revokes capabilities, frees the slot |
| `POST /v1/participants/{id}/block` | participant (sender) | Remove + refuse rejoin from that device ID and IP /64 for the session |
| `POST /v1/participants/{id}/leave` | participant (that receiver) | |
| `POST /v1/turn/credentials` | participant | Sender or `JOINED` receiver of an `ACTIVE` session; guest TTL 30 min, account 60 min |

**As built (Phase 2):** `POST /v1/sessions` and `GET /v1/sessions/{id}` return `SessionView` (`shared/protocol/openapi.yaml`), whose fields depend on the caller: the sender sees `code`, `link_token`, `join_url` (also the QR payload) while the join window is open, plus `capacity` and `participants`; a `JOINED` receiver sees `files`, `sender`, and `me` with its security words; a `REQUESTED` receiver sees the preview and its own status; a receiver that left or was removed, rejected, or blocked sees only `me`. Resolve endpoints return `JoinPreview`. Since Phase 4, `status` may also be `COMPLETED` or `PARTIALLY_COMPLETED`: when the idle or maximum lifetime ends a session it records the delivery result (`COMPLETED`, `PARTIALLY_COMPLETED`, or `EXPIRED` when nothing was delivered; `docs/ARCHITECTURE.md` §4.5), and nothing else ends a live session except Close (`CLOSED`). Window expiry and Stop accepting never end the session, so `renew` keeps working after the window. All four are ended states (`resolve-*`, `join`, `PATCH`, and `renew` return `410 session_expired`; `close` is a no-op). Join tickets are single use (`410 join_ticket_invalid` when reused); joining again while already in returns the existing participant when presented with a fresh ticket. `POST /v1/turn/credentials` takes `{"session_id"}` and returns `username`, `credential`, `uris`, `ttl`. Participant actions take no body.

**As built (Phase 4):** `GET /v1/sessions` returns `OpenSessionList`: `sessions` (each `OpenSession`: `id`, `status`, `created_at`, `expires_at`, `file_count`, `total_bytes`, `first_file_name`, `capacity`, and `join_window` with its effective state), `max_open` (the caller's open-session cap, 2 for a guest device and 5 signed in), and `server_time`. It lists exactly the sessions the open-session cap counts (owned by the device in the verified token; ended sessions, sessions past their maximum lifetime, and sessions the device only receives in are excluded), at most 20. Clients show it when `POST /v1/sessions` returns `409 too_many_open_sessions` so the sender can open or close a session (`docs/SECURITY_MODEL.md` §5). Not rate limited, like the other reads.

### 2.3 Files and transfers (Phase 3)

| Endpoint | Level | Notes |
|---|---|---|
| `GET /v1/sessions/{id}/files` | participant | Sender or `JOINED` receiver |
| `GET /v1/sessions/{id}/transfers`, `GET /v1/transfers/{id}` | participant | Sender or `JOINED` receiver; a receiver sees only its own transfers |
| `POST /v1/transfers/{id}/pause`, `/resume`, `/cancel` | participant | Resume also requires the transfer capability |
| `POST /v1/transfers/{id}/report` | participant | State, verified bytes, route type (metrics) |

**As built (Phase 3):** `GET /v1/sessions/{id}/transfers` returns `TransferList`: the sender gets every transfer plus `peers` (each receiver's status and, while `JOINED`, the hex SHA-256 of its transfer capability); a `JOINED` receiver gets its own transfers plus `capability`. Others get `404`. `report` takes `{status, verified_bytes, route?}` and validates the transition (`docs/ARCHITECTURE.md` §4.5): verified bytes never decrease or exceed the file size, only the receiver may report `COMPLETED` and only with every byte verified, terminal states accept only the same state again (idempotent), and an ended session refuses changes (`409 session_ended`). Only the receiver reports (`403 receiver_only`), and a report cannot move a transfer out of `PAUSED` into an active state (`409 use_resume`: use `resume`, which checks the capability). Errors: `invalid_status`, `invalid_route`, `invalid_bytes` (400), `invalid_transition`, `not_verified`, `use_resume` (409), `capability_required`, `receiver_only` (403), `rate_limited` (429, 300 reports / min per device). `pause`, `resume` (from `PAUSED` to `RESUMING`), and `cancel` take an optional `{capability}`; a receiver resuming must send it. Every change sends `TRANSFER_UPDATED` to the sender and that receiver. A receiver that rejoins after Remove gets its cancelled transfers back as `PENDING` with a new capability.

**As built (Phase 4):** `GET /v1/sessions/{id}/transfers` is unchanged and is what multi-receiver dashboards and result screens read: the sender gets every receiver's transfers and `peers` (statuses included, so removed and blocked receivers show with their `CANCELLED` transfers), and it stays readable after the session ends. A transfer reaching a terminal state never ends the session (`docs/ARCHITECTURE.md` §4.5): clients derive their result screens from their own transfers, and the session stays live until Close or its idle or maximum lifetime, which records the delivery result as the end status and sends `SESSION_EXPIRED` (not `SESSION_UPDATED`). The lifetime end cancels unfinished transfers; repeating a terminal report stays idempotent after that, and any other change is refused (`409`).

### 2.4 Accounts, devices, keys, history (Phase 5A)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/auth/signup`, `POST /v1/auth/signin` | device | Binds the account session to the calling device. Body includes `add_device` (default `true`) and `copy_history` (default `false`) |
| `POST /v1/auth/password-reset/request`, `POST /v1/auth/password-reset/confirm` | public | |
| `POST /v1/auth/signout` | account | Returns a new anonymous identity |
| `GET /v1/me`, `POST /v1/me/password` | account | |
| `PATCH /v1/me` | account+device | Account settings; a not-added session is read-only |
| `GET /v1/devices` | account | Account-wide Devices list |
| `PATCH /v1/devices/{id}` | account+device | Rename; a not-added session is read-only |
| `DELETE /v1/devices/{id}` | account+device | Revoke another device; the caller then rotates the ADK |
| `POST /v1/devices/current/add` | account | Adds the current device to the account |
| `GET /v1/keys`, `PUT /v1/keys/device`, `POST /v1/keys/setup`, `GET /v1/keys/recovery`, `POST /v1/keys/rotate`, `GET /v1/keys/chain`, `DELETE /v1/keys/pending/{key_version}` | account+device | Wrapped ADK blobs, device wrapping keys, recovery-wrapped copy, rotation |
| `POST /v1/keys/pairings`, `GET /v1/keys/pairings/{pairing_id}`, `GET /v1/keys/pairings/by-code/{code}`, `POST /v1/keys/pairings/by-code/{code}/wrap` | account+device | Device pairing with one-time pickup |
| `GET /v1/history/entries`, `POST /v1/history/entries`, `DELETE /v1/history/entries/{entry_id}`, `DELETE /v1/history` | account+device | Encrypted entries with `seq` cursor |

**As built (Phase 5A):** binary fields (public keys, salts, blobs, nonces, ciphertext) are base64url without padding; the server stores and returns them as opaque bytes and checks only sizes (public keys exactly 32 bytes, wrapped blobs at most 4 KB, history ciphertext at most 64 KB, nonces 12 bytes). Crypto formats live in `docs/CLIPBOARD_PROTOCOL.md`.

- **Not-added sessions are read-only.** A signed-in device that is not added can read `/v1/me` and `/v1/devices`, add itself, change its password, and sign out; every other change to the account (`PATCH /v1/me`, `PATCH /v1/devices/{id}`, keys, history) needs `account+device` (`403 device_not_added`).
- **Browser-session binding (Web, not added).** `signup`/`signin` with `add_device: false` from a Web (cookie-transport) device also set `sa_acct`: 256 random bits, `HttpOnly; SameSite=Strict; Path=/v1/devices/token`, `Secure` per `SA_COOKIE_SECURE`, and no `Max-Age`/`Expires`, so it ends with the browser session. The server keeps its SHA-256 on the account session. On `POST /v1/devices/token` such a session must present a matching `sa_acct`; otherwise the account session ends exactly like an expired one (the device leaves the account) and the response is a guest token. Responses that end or no longer need the binding (`POST /v1/devices/current/add`, sign-out, `POST /v1/devices/current/reset`, an added Web sign-in, a refresh whose session ended) expire `sa_acct` (`Max-Age=0`). Native (body-transport) devices get no binding; their not-added session keeps the 24 h limit only (`docs/ADR/0013-session-hardening.md`).
- **Tokens.** `signup` (201) and `signin` (200) return `{access_token, expires_in, account: {id, email}, device: {id, added}}`; the device ID never changes. The token carries `acct` and `dl`, and `POST /v1/devices/token` re-derives both from the device's live account session on every refresh. A token minted before sign-out, revocation, or a password reset stops granting account access at once (the backend compares `acct`/`dl` with the live session; `401 device_token_invalid` makes the client refresh). Errors: `invalid_email`, `weak_password` (10–128 characters, not a common password, not only one repeated character, not containing the email's local part), `invalid_request` (400); `invalid_credentials` (401, identical body for an unknown email, after the same Argon2id work); `email_taken`, `already_signed_in` (409); `rate_limited` (429).
- **Sign-out** returns a `DeviceSession` (the shape of `POST /v1/devices/current/reset`) for a brand-new anonymous device with the old device's platform and refresh transport: the Web gets a new `sa_device` cookie, native apps get `refresh_secret` in the body. The old device is revoked (refresh secrets deleted, sockets closed) after its account session ends and it leaves the account. Not counted against the device-creation limit (sign-ins are limited).
- **Password reset.** `request` always answers `202` with no body; the lookup, token creation, and mail run in the background so neither the response nor its timing shows whether the account exists. The mail links to `${SA_PUBLIC_URL}/reset?token=<token>` (256-bit token, SHA-256 at rest, 30 minutes, single use; issuing a new password invalidates every outstanding token). `confirm` answers `204`, ends every account session of the account, and returns `reset_token_invalid` or `weak_password` (a weak password does not consume the token).
- **Me.** `GET /v1/me` → `{id, email, created_at, device: {id, added}, history_sync}`; `PATCH /v1/me` takes `{history_sync?}` and returns the same; `POST /v1/me/password` `{current_password, new_password}` → `204` and ends every other device's account session; a wrong current password is `403 invalid_credentials` (403, not 401, so clients do not take it for an expired token), limited to 5 failures per 15 minutes per account.
- **Devices.** `GET /v1/devices` → `{devices: [{id, name, platform, added, current, last_seen_at, created_at, has_key}]}` (live account sessions of the account, current device first; not-added devices included with `added: false`). `PATCH /v1/devices/{id}` `{name}` returns the row; another account's device is `404`. `DELETE /v1/devices/{id}` (`account+device`) ends that device's account session and removes it from the account (its wrapping key, pending blobs, and pairing are deleted; it keeps its guest identity, so its file sharing is unaffected); the current device gets `409 use_signout`. `POST /v1/devices/current/add` `{copy_history?}` → `{access_token, expires_in, device: {id, added: true}}`, idempotent; the client performs the history import itself.
- **Keys.** Every ADK version v has an Ed25519 verify key `verify_key(v)` derived from ADK(v) (`docs/CLIPBOARD_PROTOCOL.md` §1, `docs/ADR/0012-key-authenticity.md`); signatures and verify keys are base64url (64 and 32 bytes). `GET /v1/keys` → `{key_version, recovery: {public_key, salt, params: {m, t, p}, signature | null} | null, devices: [{device_id, public_key | null, key_version | null, proof | null}], pending: [{key_version, blob, from_device_id}], rotation_due}`. `rotation_due` is `true` once an added device with a registered wrapping key has left the account by any path (revoke, sign-out, password reset, password change, identity reset, refresh-secret reuse, expiry) since the last rotation; it is set in the same transaction as the departure, a successful rotation clears it, and a ready client rotates when it sees it (`docs/ADR/0014-current-version-proofs.md`). `recovery.signature` is the setup signature by ADK(1) over `sa-recoverykey-v1|<b64u(public_key)>` (`null` for legacy accounts set up before it existed); a client wraps a new ADK to `recovery.public_key` only after verifying it with the verify_key(1) it derives from its own ADK(1), and the recovery key never changes after setup (`docs/ADR/0015-authenticated-recovery-key.md`). `PUT /v1/keys/device` `{public_key, key_version, proof}` → `204`: `proof` is a signature by ADK(`key_version`) over `sa-devkey-v1|<caller device ID>|<key_version>|<b64u(public_key)>`, the device ID coming from the token; `key_version` must be the account's current version, else `409 key_version_conflict` and nothing is stored (a device holding only older versions must pair again or use the recovery phrase; after a rotation each device registers again with a proof by the new version); before setup, or when the proof does not verify, it is `403 device_key_unproven` (malformed fields are `400`), and a legacy account is `409 keys_legacy`. Replacing a different key drops pending blobs wrapped to the old one. `POST /v1/keys/setup` `{recovery_public_key, salt, params, recovery_blob, verify_key, recovery_anchor, recovery_key_signature}` → `201 {key_version: 1}` or `409 keys_exist`; `verify_key` is verify_key(1), `recovery_anchor` the 32-byte HMAC that binds it to the recovery phrase, and `recovery_key_signature` the Ed25519 signature by ADK(1) over `sa-recoverykey-v1|<b64u(recovery_public_key)>`, verified with `verify_key` (`403 recovery_key_unverified` when it does not verify, `400` when malformed; nothing stored). `GET /v1/keys/recovery` → `{key_version, recovery_blob, salt, params, recovery_anchor | null}` (`404` before setup; `null` for legacy accounts). `POST /v1/keys/rotate` `{key_version, recovery_blob, chain_blob, device_blobs, verify_key, signature}` runs under the account key-row lock: `409 key_version_conflict` unless `key_version` is current + 1; `409 keys_legacy` when the current version has no stored verify key; `403 rotation_unauthorized` (nothing stored) unless `signature` verifies with the stored verify_key(current) over `sa-rotate-v1|<v+1>|<b64u(verify_key)>|<b64u(SHA-256(chain_blob))>`; `403 device_key_unproven` (nothing stored) unless the caller's own wrapping key is registered and proven at the current version; the caller's account session is re-checked after the lock (`401` if it ended meanwhile); the blobs must go exactly to the other added devices whose registered proof is by the current version v, else `409 devices_changed` with both `missing` (such devices that got no blob) and `unexpected` (blobs for any other device: no registered key, a proof by an older version, or not an added device of the account), both arrays always present and sorted, and nothing is stored. A successful rotation clears `rotation_due`. A blob for the caller itself is accepted as a safety copy and appears in its own `pending` list. `DELETE /v1/keys/pending/{key_version}` is idempotent. `GET /v1/keys/chain` → `{chain: [{key_version, blob}], versions: [{key_version, verify_key, signature | null}]}` oldest first; `versions` covers 1..current (`signature` is `null` for version 1; both are `null` only for legacy rows).
- **Pairing.** `POST /v1/keys/pairings` `{ephemeral_public_key}` → `201 {pairing_id, code, expires_at}`; the code is 128 random bits as 22 base64url characters, valid 10 minutes, stored as SHA-256, and a new pairing replaces the device's earlier one. `GET /v1/keys/pairings/by-code/{code}` → `{pairing_id, ephemeral_public_key, device_id, device_name}`; expired, wrapped, consumed, other-account, and own codes are all `404`. `POST …/by-code/{code}/wrap` `{key_version, sender_public_key, blob}` → `204` once (then `404`); `sender_public_key` must be the caller's registered (proven) wrapping key (`403 device_key_unproven`); `key_version` must be the account's current version (`409 key_version_conflict`). `GET /v1/keys/pairings/{pairing_id}` (the new device only) → `{status: waiting | ready | expired, key_version?, sender_public_key?, blob?}`; `ready` is returned once, the blob is then deleted, and later calls report `expired`.
- **History.** `POST /v1/history/entries` `{entry_id, key_version, nonce, ciphertext}` → `201 {seq}`; `entry_id` is client-generated in the lowercase canonical 8-4-4-4-12 hex form (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) because it is part of the AAD; uppercase, braced, unhyphenated, or URN spellings are `400 invalid_request` on POST and on `DELETE /v1/history/entries/{entry_id}`, and the server returns ids in that form. Repeating an `entry_id` returns the original `seq` and changes nothing (a deleted entry is not resurrected); `key_version` must be the account's current version, else `409 key_version_conflict` and nothing is stored (the client runs a key check, picking up the rotation, and retries once; `docs/ADR/0015-authenticated-recovery-key.md`). The check runs before the version can change: the account key row is held `FOR SHARE` until the entry is stored. `GET /v1/history/entries?after=&limit=` (limit 1–500, default 200) → `{entries: [{entry_id, seq, key_version, nonce?, ciphertext?, origin_device_id, created_at, deleted}], next_after}`; tombstones have `deleted: true` and no nonce or ciphertext. `DELETE /v1/history/entries/{entry_id}` and `DELETE /v1/history` tombstone with new `seq` values. `seq` is assigned under `pg_advisory_xact_lock(1, hashtext(user_id))` (`docs/ARCHITECTURE.md` §8). The server accepts entries from any added device; `history_sync` in `/v1/me` is the account-wide switch clients honor.
- WebSocket `HISTORY_ENTRY_*` events (§4) are not built yet; clients poll `GET /v1/history/entries` with their cursor. `DEVICE_CONNECTED` / `DEVICE_DISCONNECTED` arrive with Phase 5B (§2.5, §4).

### 2.5 Clipboard (Phase 5B)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/clipboard/events`, `GET /v1/clipboard/events?cursor=`, `GET /v1/clipboard/history` | account+device | Encrypted text events with a per-user `seq` cursor |
| `DELETE /v1/clipboard/events/{event_id}`, `DELETE /v1/clipboard/history` | account+device | Tombstones with new `seq` values |
| `GET /v1/clipboard/settings`, `PUT /v1/clipboard/settings` | account+device | Account-wide pause, retention, sensitive handling |

**As built (Phase 5B, `backend/internal/clipboard`):** binary fields are base64url without padding; the server stores ciphertext only and checks sizes. Encryption (AES-256-GCM under the ADK's `clipboard-v1` subkey, AAD `<event_id>|<key_version>`) lives in `docs/CLIPBOARD_PROTOCOL.md`. Guests get `403 account_required` and signed-in devices that are not added get `403 device_not_added` on every route.

- **Create.** `POST /v1/clipboard/events` `{event_id, key_version, nonce, ciphertext, payload_size, event_type?: "TEXT", mime_type?: "text/plain"}` → `201 {seq, created_at, expires_at}`. `event_id` is client-generated in the lowercase canonical 8-4-4-4-12 hex form (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) because it is part of the AAD; any other spelling (uppercase, braces, no hyphens, URN) is `400 invalid_request`, and the server returns ids in that form. `nonce` is 12 bytes; `payload_size` is the UTF-8 byte length of the plaintext, 1 to 262,144; in v1 the decoded `ciphertext` must be exactly `payload_size` + 16 bytes (the AES-GCM tag), else `400 invalid_request`, so it is 17 to 262,160 bytes. `payload_size` above 262,144, ciphertext above 262,160 bytes, or a body too large to hold them is `413 payload_too_large`; other malformed fields are `400`. Repeating an `event_id` returns the stored `seq`, `created_at`, and `expires_at` (`201` again) and changes nothing; a deleted event returns its tombstone `seq` and is not restored. A new event must carry the account's current `key_version` (`409 key_version_conflict`, nothing stored; the client runs a key check, re-encrypts, and retries once). When the account paused Clipboard Sync, a new event is `409 clipboard_paused` and nothing is stored (a retry of an event stored earlier still answers `201`). `expires_at` is `created_at` plus the account's `retention_days` at insert time. Inserting beyond 100 live events tombstones the oldest live one in the same transaction (it gets the next `seq` after the new event). Limits: 60 per minute per device and 240 per minute per account (`429 rate_limited`, `docs/SECURITY_MODEL.md` §5).
- **Order.** `seq` is assigned in the insert transaction under `pg_advisory_xact_lock(2, hashtext(user_id))` (history uses class 1), so `seq` order equals commit order; it comes from a per-account counter, so it is never reused after the retention sweep removes rows. Every write takes the clipboard lock, then holds the account key row `FOR SHARE` and re-checks the caller's account session (`401 device_token_invalid` if the device left meanwhile).
- **Read.** `GET /v1/clipboard/events?cursor=<seq ≥ 0, default 0>&limit=<1..200, default 100>` → `{events: [{event_id, seq, origin_device_id, event_type, mime_type, key_version, nonce, ciphertext, payload_size, created_at, expires_at, deleted}], next_cursor}` ascending by `seq`; tombstones have `deleted: true` and `nonce`/`ciphertext` `null`; `next_cursor` is the last `seq` returned (the sent cursor when the page is empty). The call records the caller device's cursor as the `cursor` it sent (what it has applied) in `clipboard_device_cursors`; the recorded value never moves backwards and never passes the account's highest `seq`. `GET /v1/clipboard/history?limit=<1..100, default 100>` → `{events: [live events, newest first], cursor}` where `cursor` is the account's highest `seq` (0 if none), read from the same snapshot; the client then follows `GET /v1/clipboard/events?cursor=`. Live events past `expires_at` that the sweep has not removed yet are left out of both. The two reads share a per-device limit of 600 per minute (`429 rate_limited`, `docs/SECURITY_MODEL.md` §5).
- **Delete.** `DELETE /v1/clipboard/events/{event_id}` → `204` (a tombstone with a new `seq`; deleting a tombstone again changes nothing; an `event_id` not in the lowercase canonical form `400 invalid_request`; unknown or another account's event `404`). `DELETE /v1/clipboard/history` → `204` (every live event becomes a tombstone, each with a new `seq`). Both work while paused. Deletions, clear, and settings changes share a per-device limit of 600 per minute.
- **Settings.** `GET /v1/clipboard/settings` → `{paused, retention_days, sensitive_skip}`, defaults `false` / `7` / `true` until the account stores its own (reading does not create a row). `PUT /v1/clipboard/settings` takes the same shape, every field required (`retention_days` 1..7), and returns the stored settings (`200`). A new retention applies to events created afterwards.
- **Retention.** The account maintenance loop (every 5 minutes) hard-deletes live events past `expires_at` and tombstones older than 7 days, in bounded batches that skip rows a write is holding (they go in the next pass; `docs/ARCHITECTURE.md` §8).
- **Leaving the account** (sign-out, revoke, password reset or change, identity reset, refresh-secret reuse, expiry) deletes the device's `clipboard_device_cursors` row in the same transaction; its token stops granting access at once.
- **WebSocket** (§4): after each change the server sends `CLIPBOARD_EVENT_CREATED` `{event_id, seq, origin_device_id, created_at, payload_size, key_version}`, `CLIPBOARD_EVENT_DELETED` `{event_id, seq}` (also for a cap tombstone), `CLIPBOARD_HISTORY_CLEARED` `{seq}` (the highest tombstone `seq`; only when something was cleared), and `CLIPBOARD_SETTINGS_UPDATED` `{paused, retention_days, sensitive_skip}` to every open socket of the account's devices that have a live added account session at send time, the origin device included. A retry that stores nothing sends nothing. No ciphertext or plaintext goes over WebSocket; clients fetch with `GET /v1/clipboard/events?cursor=` on any `CLIPBOARD_*` message and on reconnect.

### 2.6 Cloud Distribution (Phase 8)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/files/{id}/distribute` | account (sender) | Guests get `403 cloud_requires_account`; no consent gives `403 cloud_consent_required` |
| `GET /v1/cloud/settings`, `PUT /v1/cloud/settings` | account | Consent, budget cap |
| `GET /v1/cloud/objects/{id}` | participant | Download URL for a `JOINED` receiver, guest or signed in |

### 2.7 Session files after creation (backlog, not scheduled)

Files are chosen before the session is created (`POST /v1/sessions` carries their metadata, PRD §5.3). Adding or removing files in a live session is not part of any phase yet; these rows reserve the shape.

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/sessions/{id}/files`, `DELETE /v1/files/{id}` | participant (sender) | Would create or cancel transfers for every JOINED receiver |

## 3. Errors

All errors use `{"error": "<code>", "message": "<human text>", "retry_after_s": <int, optional>}`.

| HTTP | Code | When |
|---|---|---|
| 400 | `invalid_request` | Malformed body, unknown field, or a non-empty body without `Content-Type: application/json`; a history `entry_id` or clipboard `event_id` (body or path) not in the lowercase canonical UUID form; a clipboard ciphertext that is not exactly `payload_size` + 16 bytes |
| 400 | `over_limit` | Session over 20 GB or 1,000 files |
| 400 | `invalid_email`, `weak_password`, `reset_token_invalid` | Sign-up email or password policy; reset token unknown, used, or expired (Phase 5A) |
| 400 | `invalid_status`, `invalid_route`, `invalid_bytes` | Transfer report with an unknown status or route, or verified bytes that decrease or exceed the file size |
| 401 | `device_token_invalid`, `device_token_expired` | Missing, malformed, wrong `alg`/`kid`, tampered, or expired token |
| 401 | `refresh_invalid`, `refresh_reused` | Unknown, expired or revoked refresh secret; a consumed or retired secret presented again outside the one-time grace (the device is revoked) |
| 401 | `invalid_credentials` | Sign-in with a wrong password or unknown email (same body). `POST /v1/me/password` uses `403 invalid_credentials` |
| 401 | `ticket_invalid` | WebSocket ticket missing, used, or expired |
| 403 | `account_required` | Account endpoint with a guest token |
| 403 | `device_not_added` | Keys, clipboard, history, or an account change (`PATCH /v1/me`, `PATCH /v1/devices/{id}`) with a signed-in but not-added device |
| 403 | `rotation_unauthorized`, `device_key_unproven`, `recovery_key_unverified` | A key rotation not signed by the current ADK version (nothing stored); a device wrapping key whose proof does not verify for the caller, a rotation by a device whose own key is not proven at the current version, or a pairing wrap whose sender key is not the caller's registered key; a key setup whose recovery key signature does not verify with its verify key (nothing stored) |
| 403 | `blocked` | Device or IP /64 blocked from this session |
| 403 | `capability_required`, `receiver_only` | A receiver resumed a transfer without its transfer capability; the sender sent a transfer report |
| 403 | `cloud_requires_account`, `cloud_consent_required` | Cloud Distribution preconditions |
| 403 | `csrf_header_missing` | Cookie refresh without `X-SA-Refresh: 1` |
| 403 | `origin_not_allowed` | WebSocket upgrade from an origin outside `SA_ALLOWED_ORIGINS` |
| 403 | `forbidden` | Only the sender may take this action |
| 404 | `not_found` | Unknown resource or no access (existence hidden) |
| 404 | `code_not_found`, `link_not_found` | Unknown code or link token (counts as a failed lookup for codes) |
| 405 | `method_not_allowed` | Known path, wrong method; `Allow` header lists the methods |
| 409 | `email_taken`, `already_signed_in`, `use_signout` | Sign-up with a registered email; sign-in or sign-up on a device that already has an account session; revoking the current device |
| 409 | `keys_exist`, `key_version_conflict`, `devices_changed`, `pairing_conflict` | Key setup twice; a key version that is not current (+1 for rotation; a new history entry or clipboard event under an older key); a device key proof by a version other than the current one; rotation blobs that do not match the devices proven at the current version (`missing`, `unexpected`); two pairings started at once |
| 409 | `clipboard_paused` | A new clipboard event while the account paused Clipboard Sync (nothing stored; reads, deletes, and settings still work) |
| 409 | `keys_legacy` | Rotation or device-key registration on an account whose keys predate key verification (no stored verify key) |
| 409 | `session_full` | Five receivers already joined or requested |
| 409 | `too_many_open_sessions` | Guest device already has 2 open sessions (signed in: 5) |
| 409 | `invalid_transition`, `not_verified`, `use_resume`, `session_ended` | Transfer state change not allowed now; `COMPLETED` before every byte is verified; a report leaving `PAUSED` for an active state (`use_resume`; `COMPLETED` with every byte verified is allowed); changes after the session ended |
| 409 | `invalid_state`, `own_session`, `session_not_active` | Action does not apply to the current state; resolving your own code; TURN before a receiver joined |
| 410 | `join_window_expired` | The 10-minute join window for this code, link, or QR has ended or was replaced by Create new code |
| 410 | `session_not_accepting`, `session_expired` | Sender tapped Stop accepting, or the session lifetime ended |
| 410 | `join_ticket_invalid` | Join ticket unknown, used, revoked, or for another device |
| 413 | `payload_too_large` | A clipboard event whose `payload_size` exceeds 262,144 or whose ciphertext exceeds 262,160 bytes, or a body too large to hold them |
| 428 | `pow_required` | Device creation above the soft limit; body carries the proof-of-work challenge |
| 429 | `rate_limited`, `locked_out` | With `Retry-After` header and `retry_after_s` |
| 429 | `too_many_connections` | WebSocket cap per device or address reached |
| 500 | `internal` | Unexpected server error; the body never includes details |

## 4. WebSocket

Connect to `/v1/ws?ticket=<one-time ticket>`. The server checks `Origin`, consumes the ticket, and binds the socket to the device and, if present, the account.

| Event | Delivered to |
|---|---|
| `WELCOME` (device ID, `server_time`) | Every socket, first message after the ticket is consumed (Phase 1) |
| `ERROR` (`code`, `ref`) | The socket whose message could not be handled: `bad_message`, `unknown_type`, `not_found` (not a joined participant or not a sender–receiver pair), `peer_offline`, `payload_too_large`, `internal` |
| `OFFER`, `ANSWER`, `ICE_CANDIDATE` | The two participants of a sender–receiver pair, only after the receiver is `JOINED`. Client sends `{type, ref?, session_id, to: participant_id, payload}`; the target gets `{type, session_id, from: participant_id, payload}` |
| `PARTICIPANT_JOINED`, `PARTICIPANT_REQUESTED`, `PARTICIPANT_APPROVED`, `PARTICIPANT_REJECTED`, `PARTICIPANT_REMOVED`, `PARTICIPANT_BLOCKED`, `PARTICIPANT_LEFT` | Sender; the affected receiver gets its own status changes |
| `SESSION_UPDATED` (require approval; `join_window.state` and `join_window.ends_at`, including expiry and Create new code), `SESSION_CLOSED`, `SESSION_EXPIRED`, `PROTECTED_MODE` | All participants of the session |
| `TRANSFER_UPDATED` (`transfer`: status, verified bytes, route) | The sender and that transfer's receiver, after a report or a pause, resume, or cancel (Phase 3) |
| `CLIPBOARD_EVENT_CREATED`, `CLIPBOARD_EVENT_DELETED`, `CLIPBOARD_HISTORY_CLEARED`, `CLIPBOARD_SETTINGS_UPDATED` | Every open socket of the account's devices that have a live added account session at send time, the origin device included (Phase 5B; payloads in §2.5) |
| `DEVICE_CONNECTED`, `DEVICE_DISCONNECTED` (`device_id`) | The account's other added devices, when an added device opens its first socket or closes its last one (Phase 5B). Guests, not-added, and departed devices announce nothing. Sent asynchronously after the device's `WELCOME` (best effort; the handshake never waits for it) |
| `HISTORY_ENTRY_CREATED`, `HISTORY_ENTRY_DELETED` | `account+device` sockets of that account (not built yet) |

WebSocket messages carry metadata only. Clipboard ciphertext and history ciphertext are fetched over HTTPS. The schema lives in `shared/protocol/websocket-events.json` from Phase 1.
