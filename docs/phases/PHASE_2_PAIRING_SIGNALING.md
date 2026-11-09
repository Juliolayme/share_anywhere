# Phase 2 — Share sessions, pairing, approval, signaling (first vertical slice, no account)

Read: PRD §2 (guest-first, abuse controls), §5.2–§5.5, §6.7, §8.2–§8.5, §11, §13 (Guest-first, Abuse and rate limits, Pairing); `docs/TESTING_AND_CI.md` §3, §4.

This is the **first vertical slice**, and it requires **no account**: a guest opens the Web app → anonymous device identity → create Share Session → QR / six-digit code / link → a guest receiver joins → sender approves. No test in this phase may sign in; accounts do not exist yet.

## Scope
- Migrations: `share_sessions` (`owner_device_id` required, `owner_user_id` nullable and unused until Phase 5A), `session_participants` (`device_id` required, `user_id` nullable), `session_blocks`, `shared_files`, `capability_tokens`, `session_events`.
- Create session with file metadata (device level); six-digit code stored as HMAC with a server pepper, rotating every 10 minutes, valid only while accepting receivers; HTTPS share link and QR payload carrying a join capability token (≥ 128-bit, hashed at rest, 15-minute TTL, renewable by the sender).
- Join by code or link returns a preview and a single-use 5-minute join ticket; `request-access` with the ticket creates a `REQUESTED` participant; verification words derived per session and device, shown on both sides.
- Approve / reject / block / remove / leave / stop-accepting; atomic max-5 with `SELECT … FOR UPDATE`; per-session cap of 10 pending requests.
- Session and participant state machines with idempotent transitions; lifetimes per PRD §8.3 (waiting 30 min, idle 30 min, guest max 24 h, concurrent open sessions per guest device 2); expiry and purge jobs (session records purged 7 days after end).
- Rate limits per PRD §8.4 for session creation, code lookup (with lockout), join requests, and TURN credentials.
- WebSocket signaling: rooms per session, participant-scoped authorization, message types `OFFER, ANSWER, ICE_CANDIDATE, PARTICIPANT_REQUESTED, PARTICIPANT_APPROVED, PARTICIPANT_REJECTED, PARTICIPANT_BLOCKED, PARTICIPANT_LEFT, SESSION_CLOSED, SESSION_EXPIRED`. No signaling to unapproved participants.
- `turncreds`: coturn HMAC credentials for the sender and approved receivers of an `ACTIVE` session with the guest TTL and limits from PRD §6.7.
- Web: Send flow screens 1–9 of PRD §5.3 (transfer cards show `PENDING`; bytes arrive in Phase 3) with the Cloud option absent (Phase 8); Receive flow screens 1–7 of §5.4, Web Join Page at `/join/:token` (first-time visitors skip Welcome) and `/join` code entry; QR rendering. Turn on the `sharing` flag.
- `docs/SECURITY_MODEL.md` extended with code enumeration, request flooding, impersonation, and TURN abuse rows.

## Out of scope
File bytes over DataChannel, accounts, Android, iOS, Cloud.

## Tests to add
- Backend: max-5 race (20 concurrent guest devices requesting, exactly 5 succeed, `-race`); pending-request cap; blocked device cannot re-request; expired/revoked/rejected token returns 404; code lookup rate limit and lockout from one IP across many devices; session creation limit per device and per IP; concurrent-open-session cap for guests; TURN credential refused before approval, after session end, and over limit; credential validates against the coturn container and expires at the guest TTL; signaling denied for unapproved participants; waiting/idle/max-lifetime expiry with an injected clock; purge job; access-level route test updated.
- Playwright, all participants as guests: sender on `chromium-desktop`, receiver on each of `firefox-desktop`, `webkit-desktop`, `android-chrome`, `ios-safari`: create session → receiver opens link (fresh context, no Welcome) → preview → request → verification words match on both pages → sender approves → both see `APPROVED`; same via six-digit code; rejection; block then re-request refused; sixth receiver sees "session full"; expired link page; rate-limited code entry shows the wait message. Mobile projects assert QR and code legibility at the project viewport (snapshot).
- Web unit: state machine reducers, verification-words rendering, countdowns for code rotation and token TTL.

## CI changes
`e2e-web` matrix runs the full `transfer/pairing` spec folder; coturn added to `docker-compose.ci.yml`.

## Exit gate
Guest vertical slice green in all receiver projects; race test green under `-race`; all rate-limit and TTL tests green; no signaling reachable before approval (negative test); report written.
