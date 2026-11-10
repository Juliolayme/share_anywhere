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
| `POST /v1/sessions` | device | Body includes file metadata and `require_approval` (default `false`). Returns code, link token, QR payload (`join_url`), `join_window` (`state`, `opened_at`, `ends_at` = now + 10 min, `seq`), and `server_time` |
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

### 2.7 Session files after creation (backlog, not scheduled)

Files are chosen before the session is created (`POST /v1/sessions` carries their metadata, PRD §5.3). Adding or removing files in a live session is not part of any phase yet; these rows reserve the shape.

| Endpoint | Level | Notes |
|---|---|---|
| `POST /v1/sessions/{id}/files`, `DELETE /v1/files/{id}` | participant (sender) | Would create or cancel transfers for every JOINED receiver |

## 3. Errors

All errors use `{"error": "<code>", "message": "<human text>", "retry_after_s": <int, optional>}`.

| HTTP | Code | When |
|---|---|---|
| 400 | `invalid_request` | Malformed body, unknown field, or a non-empty body without `Content-Type: application/json` |
| 400 | `over_limit` | Session over 20 GB or 1,000 files |
| 400 | `invalid_status`, `invalid_route`, `invalid_bytes` | Transfer report with an unknown status or route, or verified bytes that decrease or exceed the file size |
| 401 | `device_token_invalid`, `device_token_expired` | Missing, malformed, wrong `alg`/`kid`, tampered, or expired token |
| 401 | `refresh_invalid`, `refresh_reused` | Unknown, expired or revoked refresh secret; a consumed secret presented again (the device is revoked) |
| 401 | `ticket_invalid` | WebSocket ticket missing, used, or expired |
| 403 | `account_required` | Account endpoint with a guest token |
| 403 | `device_not_added` | Keys, clipboard, or history with a signed-in but not-added device |
| 403 | `blocked` | Device or IP /64 blocked from this session |
| 403 | `capability_required`, `receiver_only` | A receiver resumed a transfer without its transfer capability; the sender sent a transfer report |
| 403 | `cloud_requires_account`, `cloud_consent_required` | Cloud Distribution preconditions |
| 403 | `csrf_header_missing` | Cookie refresh without `X-SA-Refresh: 1` |
| 403 | `origin_not_allowed` | WebSocket upgrade from an origin outside `SA_ALLOWED_ORIGINS` |
| 403 | `forbidden` | Only the sender may take this action |
| 404 | `not_found` | Unknown resource or no access (existence hidden) |
| 404 | `code_not_found`, `link_not_found` | Unknown code or link token (counts as a failed lookup for codes) |
| 405 | `method_not_allowed` | Known path, wrong method; `Allow` header lists the methods |
| 409 | `session_full` | Five receivers already joined or requested |
| 409 | `too_many_open_sessions` | Guest device already has 2 open sessions (signed in: 5) |
| 409 | `invalid_transition`, `not_verified`, `use_resume`, `session_ended` | Transfer state change not allowed now; `COMPLETED` before every byte is verified; a report leaving `PAUSED` for an active state (`use_resume`; `COMPLETED` with every byte verified is allowed); changes after the session ended |
| 409 | `invalid_state`, `own_session`, `session_not_active` | Action does not apply to the current state; resolving your own code; TURN before a receiver joined |
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
| `SESSION_UPDATED` (require approval; `join_window.state` and `join_window.ends_at`, including expiry and Create new code), `SESSION_CLOSED`, `SESSION_EXPIRED`, `PROTECTED_MODE` | All participants of the session |
| `TRANSFER_UPDATED` (`transfer`: status, verified bytes, route) | The sender and that transfer's receiver, after a report or a pause, resume, or cancel (Phase 3) |
| `CLIPBOARD_EVENT_CREATED`, `CLIPBOARD_EVENT_DELETED`, `CLIPBOARD_HISTORY_CLEARED`, `CLIPBOARD_SETTINGS_UPDATED` | `account+device` sockets of that account |
| `HISTORY_ENTRY_CREATED`, `HISTORY_ENTRY_DELETED`, `DEVICE_CONNECTED`, `DEVICE_DISCONNECTED` | `account+device` sockets of that account |

WebSocket messages carry metadata only. Clipboard ciphertext and history ciphertext are fetched over HTTPS. The schema lives in `shared/protocol/websocket-events.json` from Phase 1.
