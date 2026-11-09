# Phase 2 — Share sessions, pairing, approval, signaling

Read: PRD §5.2–§5.5, §6.7, §8, §11, §13 (Pairing); `docs/TESTING_AND_CI.md` §3, §4.

## Scope
- `share_sessions`, `session_participants`, `shared_files`, `capability_tokens`, `session_events` migrations.
- Create session with file metadata; six-digit code (lookup only, 10-minute rotation, rate-limited); HTTPS share link and QR payload carrying a capability token (≥ 128-bit, hashed at rest, 15-minute TTL, renewable by sender).
- Join by code, join by link, guest join (ephemeral device, PRD §2).
- Approve / reject / remove / leave; atomic max-5 with `SELECT … FOR UPDATE`.
- Session state machine and participant state machine with idempotent transitions.
- WebSocket signaling: rooms per session, participant-scoped authorization, message types `OFFER, ANSWER, ICE_CANDIDATE, PARTICIPANT_REQUESTED, PARTICIPANT_APPROVED, PARTICIPANT_REJECTED, PARTICIPANT_LEFT, SESSION_CLOSED, SESSION_EXPIRED`. No signaling to unapproved participants.
- TURN credential endpoint (`turncreds`) issuing coturn HMAC credentials to approved participants only; `iceServers` returned to clients.
- Web: Send flow screens 1–9 of PRD §5.3 (no actual bytes yet; transfer cards show `PENDING`), Receive flow screens 1–7 of §5.4 including Web Join Page at `/join/:token` and `/join` code entry; QR rendering (`qrcode` lib) and on Web a camera QR scanner is **not** required (code entry and link cover Web).
- Session expiry job and cleanup.

## Out of scope
Actual file bytes over DataChannel, Android.

## Deliverables
- `backend/internal/{sharing,signaling,turncreds}`; OpenAPI and WS schema updates; `docs/TRANSFER_PROTOCOL.md` §Signaling.
- `web/src/features/transfer/{send,receive,session}`.

## Tests to add
- Backend: max-5 race test (20 concurrent joins, exactly 5 succeed, `-race`); expired/revoked/rejected token returns 404; code lookup rate limit; signaling denied for unapproved participant; TURN credential validates against coturn container and expires.
- Playwright: two-context vertical slice on `chromium-desktop` (sender) + receiver on each of `firefox-desktop`, `webkit-desktop`, `android-chrome`, `ios-safari`: create session → receiver opens link → preview → request → sender approves → both see `APPROVED`; rejection path; sixth receiver UI shows "session full"; expired link page. Mobile projects assert QR and code remain legible at the project viewport (snapshot).
- Web unit: state machine reducers.

## CI changes
`e2e-web` matrix now runs the full `transfer/pairing` spec folder; coturn added to `docker-compose.ci.yml`.

## Exit gate
Vertical slice green in all receiver projects; race test green under `-race`; no signaling reachable before approval (negative test); report written.
