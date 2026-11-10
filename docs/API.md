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
| `POST /v1/devices/token` | public (refresh secret) | Rotates the secret; reuse revokes the device. Web requires `X-SA-Refresh: 1` |
| `GET /v1/devices/current`, `PATCH /v1/devices/current` | device | Display name, platform |
| `POST /v1/devices/current/reset` | device | New anonymous identity; ends this device's open sessions |
| `POST /v1/ws/ticket` | device | One-time ticket, 30 s |
| `GET /v1/ws?ticket=` | public (one-time ticket) | WebSocket upgrade. `Origin` must be an allowed origin (absent for native apps); the ticket is consumed on use. Limits in `docs/SECURITY_MODEL.md` §5 |

### 2.2 Share sessions and joining (Phase 2)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/sessions` | device | Body includes file metadata and `require_approval` (default `false`). Returns code, link token, QR payload, `join_window_ends_at` (now + 10 min), and `server_time` |
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

### 2.3 Files and transfers (Phases 2–4)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/sessions/{id}/files`, `DELETE /v1/files/{id}` | participant (sender) | |
| `GET /v1/sessions/{id}/files` | participant | Sender or `JOINED` receiver |
| `GET /v1/sessions/{id}/transfers`, `GET /v1/transfers/{id}` | participant | Sender or `JOINED` receiver; a receiver sees only its own transfers |
| `POST /v1/transfers/{id}/pause`, `/resume`, `/cancel` | participant | Resume also requires the transfer capability |
| `POST /v1/transfers/{id}/report` | participant | State, verified bytes, route type (metrics) |

### 2.4 Accounts, devices, keys, history (Phase 5A)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/auth/signup`, `POST /v1/auth/signin` | device | Binds the account session to the calling device. Body includes `add_device` (default `true`) and `copy_history` (default `false`) |
| `POST /v1/auth/password-reset/request`, `POST /v1/auth/password-reset/confirm` | public | |
| `POST /v1/auth/signout` | account | Returns a new anonymous identity |
| `GET /v1/me`, `PATCH /v1/me`, `POST /v1/me/password` | account | |
| `GET /v1/devices`, `PATCH /v1/devices/{id}`, `DELETE /v1/devices/{id}` | account | Delete = revoke; triggers ADK rotation |
| `POST /v1/devices/current/add` | account | Adds the current device to the account |
| `/v1/keys/*` | account+device | Wrapped ADK, pairings, recovery-wrapped copy |
| `GET /v1/history/entries`, `POST /v1/history/entries`, `DELETE /v1/history/entries/{id}`, `DELETE /v1/history` | account+device | Encrypted entries with `seq` cursor |

### 2.5 Clipboard (Phase 5B)

| Endpoint | Level |
|---|---|
| `POST /v1/clipboard/events`, `GET /v1/clipboard/events?cursor=`, `GET /v1/clipboard/history` | account+device |
| `DELETE /v1/clipboard/events/{id}`, `DELETE /v1/clipboard/history` | account+device |
| `GET /v1/clipboard/settings`, `PUT /v1/clipboard/settings` | account+device |

### 2.6 Cloud Distribution (Phase 8)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/files/{id}/distribute` | account (sender) | Guests get `403 cloud_requires_account`; no consent gives `403 cloud_consent_required` |
| `GET /v1/cloud/settings`, `PUT /v1/cloud/settings` | account | Consent, budget cap |
| `GET /v1/cloud/objects/{id}` | participant | Download URL for a `JOINED` receiver, guest or signed in |

## 3. Errors

All errors use `{"error": "<code>", "message": "<human text>", "retry_after_s": <int, optional>}`.

| HTTP | Code | When |
|---|---|---|
| 400 | `invalid_request` | Malformed body, unknown field, or a non-empty body without `Content-Type: application/json` |
| 400 | `over_limit` | Session over 20 GB or 1,000 files |
| 401 | `device_token_invalid`, `device_token_expired` | Missing, malformed, wrong `alg`/`kid`, tampered, or expired token |
| 401 | `refresh_invalid`, `refresh_reused` | Unknown, expired or revoked refresh secret; a consumed secret presented again (the device is revoked) |
| 401 | `ticket_invalid` | WebSocket ticket missing, used, or expired |
| 403 | `account_required` | Account endpoint with a guest token |
| 403 | `device_not_added` | Keys, clipboard, or history with a signed-in but not-added device |
| 403 | `blocked` | Device or IP /64 blocked from this session |
| 403 | `cloud_requires_account`, `cloud_consent_required` | Cloud Distribution preconditions |
| 403 | `csrf_header_missing` | Cookie refresh without `X-SA-Refresh: 1` |
| 403 | `origin_not_allowed` | WebSocket upgrade from an origin outside `SA_ALLOWED_ORIGINS` |
| 403 | `forbidden` | Only the sender may take this action |
| 404 | `not_found` | Unknown resource or no access (existence hidden) |
| 404 | `code_not_found`, `link_not_found` | Unknown code or link token (counts as a failed lookup for codes) |
| 405 | `method_not_allowed` | Known path, wrong method; `Allow` header lists the methods |
| 409 | `session_full` | Five receivers already joined or requested |
| 409 | `too_many_open_sessions` | Guest device already has 2 open sessions (signed in: 5) |
| 409 | `invalid_state`, `own_session`, `too_many_requests`, `session_not_active` | Action does not apply to the current state; resolving your own code; 10 pending requests; TURN before a receiver joined |
| 410 | `join_window_expired` | The 10-minute join window for this code, link, or QR has ended or was replaced by Create new code |
| 410 | `session_not_accepting`, `session_expired` | Sender tapped Stop accepting, or the session lifetime ended |
| 410 | `join_ticket_invalid` | Join ticket unknown, used, revoked, or for another device |
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
| `SESSION_UPDATED` (require approval; join window state and `join_window_ends_at`, including expiry and Create new code), `SESSION_CLOSED`, `SESSION_EXPIRED`, `PROTECTED_MODE` | All participants of the session |
| `CLIPBOARD_EVENT_CREATED`, `CLIPBOARD_EVENT_DELETED`, `CLIPBOARD_HISTORY_CLEARED`, `CLIPBOARD_SETTINGS_UPDATED` | `account+device` sockets of that account |
| `HISTORY_ENTRY_CREATED`, `HISTORY_ENTRY_DELETED`, `DEVICE_CONNECTED`, `DEVICE_DISCONNECTED` | `account+device` sockets of that account |

WebSocket messages carry metadata only. Clipboard ciphertext and history ciphertext are fetched over HTTPS. The schema lives in `shared/protocol/websocket-events.json` from Phase 1.
