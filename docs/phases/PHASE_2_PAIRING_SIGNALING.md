# Phase 2 — Share sessions, joining, signaling (first vertical slice, no account)

Read: PRD §2 (guest-first, join and approval, keep screen on, abuse controls), §5.2–§5.5, §5.10, §13 (Guest-first, Abuse and rate limits, Join and pairing, Keep screen on); `docs/SECURITY_MODEL.md` §3 (including §3.0 join window and §3.2 guess model), §5, §6, §7; `docs/ARCHITECTURE.md` §4 (including §4.1b), §6, §7, §8; `docs/API.md` §2.2, §3, §4; `docs/UX_SCREEN_MAP.md` §4, §5; `docs/TESTING_AND_CI.md` §2b, §3, §4.

This is the **first vertical slice**, and it requires **no account**: a guest opens the Web app → anonymous device identity → create Share Session → QR / six-digit code / link → a guest receiver enters the code → **joins immediately** (open join is the default) → both see each other with verification words. No test in this phase may sign in; accounts do not exist yet.

## Scope
- Migrations for `share_sessions` (`owner_device_id` required, `owner_user_id` nullable and unused until Phase 5A, `require_approval` default `false`), `session_participants` (`device_id` required, `user_id` nullable, `joined_via`), `session_blocks` (device ID and IP prefix), `shared_files`, `capability_tokens`, `session_events`, and protected-mode state, per `docs/ARCHITECTURE.md` §8.
- Session creation with file metadata and `require_approval`; six-digit code stored as an HMAC and link/QR join tokens (≥ 128-bit, hashed), all sharing one **10-minute join window** (`join_window_state`, `join_window_ends_at`); window closes on timeout, when the fifth receiver arrives, or on Stop accepting; `renew` (Create new code) issues a new code, link, and QR, opens a fresh 10-minute window, and invalidates the old ones; joined receivers and transfers never depend on the window; `SESSION_UPDATED` on every window change; `server_time` in responses for accurate client countdowns.
- `resolve-code` and `resolve-link` return the preview, `join_window_ends_at`, and a single-use join ticket valid 5 minutes but never past the window end (`410 join_window_expired` afterwards); `join` admits the receiver as `JOINED` in open-join sessions, or as `REQUESTED` when approval is on or when protected mode applies to a code join.
- Sender controls: Remove, Block (device ID + IP /64 for the session), Stop accepting, toggle Require approval (future joins only), Approve / Reject for `REQUESTED` participants (still allowed after the window ends for requests made inside it), Create new code, Close.
- Atomic five-receiver cap with `SELECT … FOR UPDATE`; at most 10 `REQUESTED` participants per session.
- Protected mode: global failed-lookup counter, alarm threshold, 30-minute duration, `PROTECTED_MODE` event, metrics.
- Session, participant, and transfer state machines per `docs/ARCHITECTURE.md` §4.5; lifetimes per `docs/SECURITY_MODEL.md` §6; expiry and purge jobs.
- Rate limits and lockouts per `docs/SECURITY_MODEL.md` §5 for session creation, concurrent open sessions, code lookup and failed lookups, link resolution, joins, TURN credentials, and WebSocket connections.
- WebSocket signaling and session events per `docs/API.md` §4. Signaling only between the sender and `JOINED` receivers.
- `turncreds` for the sender and `JOINED` receivers of an `ACTIVE` session with guest TTL and limits.
- Web screens TR-1 to TR-5, TR-8, RX-2 to RX-5, RX-7 (outcome states) per `docs/UX_SCREEN_MAP.md`: share panel with the 10:00 join-window countdown, the "Code expired — Create new code" state (Vietnamese "Mã đã hết hạn — Tạo mã mới") with the Create new code button, the "Session full" state, participant list with badges and verification words, join toasts, Remove/Block, Stop accepting nudge, Require approval toggle, request cards, protected-mode notices, join preview, waiting screen, "Join within m:ss" in the preview's last minute, removed/blocked/full/code-expired/session-expired outcomes. Transfer cards show `PENDING`; bytes arrive in Phase 3. Turn on the `sharing` flag.
- **Keep screen on (Web), first part:** the keep-awake controller from `docs/ARCHITECTURE.md` §7 with the Screen Wake Lock API, holding while the sender's join window is open (at most 10 minutes per window) and while a receiver waits for approval, and releasing when the window ends with no transfer in progress; re-request on `visibilitychange`; unsupported and refused states; status row on TR-4, TR-5, and RX-5; setting **Keep screen on during transfers** (default on) in Settings. Phase 3 extends it to active transfers.
- Update `docs/SECURITY_MODEL.md` (status of §3, §5, §6, §7 rows implemented here), `docs/ARCHITECTURE.md` §4 and §8, and `docs/API.md` §2.2 with any deviations.

## Out of scope
File bytes over DataChannel, accounts, Android, iOS, Cloud.

## Tests to add
- Backend:
  - Open join: code join and link join return `JOINED` with no sender action; signaling allowed right after.
  - Approval: with `require_approval = true`, join returns `REQUESTED`; approve → `JOINED`; reject; toggling the setting affects only later joins.
  - Protected mode: driving the failed-lookup counter over the threshold with an injected clock turns it on; code joins in open-join sessions then return `REQUESTED`; link joins still return `JOINED`; it turns off after 30 minutes.
  - Max-5 race: 20 concurrent guest devices join an open session; exactly 5 succeed under `-race`; the rest get `409 session_full`.
  - Remove revokes capabilities and frees a slot; Block refuses rejoin from the same device and from a new anonymous identity on the same IP /64.
  - Join window with an injected clock: code, link, and QR admit at 9:59 and return `410 join_window_expired` at 10:00; a join ticket obtained at 9:58 fails after 10:00; window ends when the fifth receiver joins and on Stop accepting; Create new code returns a new code and link, restarts the 10-minute window, and the previous code and link fail immediately; Create new code returns `409 session_full` while 5 receivers are in and works again after a Remove; a receiver who joined before expiry keeps signaling, TURN, and transfer access after expiry and the session stays `ACTIVE` until its own lifetime; a pending request made before expiry can still be approved after it; Create new code rate limit; revoked or rejected tokens return the documented errors.
  - Failed-lookup lockouts per IP (many devices) and per device; session creation and concurrent-session limits; TURN credentials refused for non-joined participants, after the session ends, and over limit; credentials validate against coturn and expire at the guest TTL.
  - Idle and maximum lifetime expiry (24 h guest, 72 h signed-in) with an injected clock; a session with an ended window and no receivers stays `WAITING` until Create new code, Close, or idle expiry; purge after 7 days.
  - Access-level route test updated for every new endpoint (`docs/API.md` §1).
- Web unit: state reducers; join-window countdown from `join_window_ends_at` with server time offset, expired and full states, Create new code resets to 10:00; verification-words rendering; keep-awake controller (acquire while the join window is open, release when it ends with no transfer, release on close/expire/leave/remove, setting off never acquires, re-request on visible, unsupported and `NotAllowedError` statuses).
- Playwright, all participants guests; sender on `chromium-desktop`, receiver on each of `firefox-desktop`, `webkit-desktop`, `android-chrome`, `ios-safari`:
  - Receiver opens the link in a fresh context (no Welcome) → preview → Receive → `JOINED` immediately; sender sees the join toast, badge, and the same verification words.
  - Same via six-digit code.
  - Require approval on → receiver waits → approve; reject path.
  - Remove and Block from the sender; blocked receiver cannot rejoin.
  - Stop accepting → code and link refused with the right message.
  - Join window (clock advanced through a test-only hook): sender's screen counts down from 10:00, switches to "Code expired — Create new code" and hides the old code, link, and QR; a receiver entering the old code sees "This code has expired. Ask the sender for a new code."; Create new code shows a new code at 10:00 and the receiver can join with it; a receiver who joined earlier keeps receiving across the expiry; the wake lock stub records a release when the window ends with nobody transferring.
  - Sixth receiver sees "session full"; expired link page; locked-out code entry shows the wait time.
  - Protected mode (forced through a test-only admin hook) → code join waits for approval with the explanation.
  - Keep screen on with `navigator.wakeLock` stubbed through `addInitScript` in three modes: granted (status "Screen stays on", `release()` called after Close session), refused (refused status), unsupported (reminder "Keep this tab open and visible"); hidden → visible re-request; Settings toggle off → no request.
  - Mobile projects assert QR and code legibility at the project viewport (snapshot).

## CI changes
`e2e-web` matrix runs the full `transfer/pairing` and `keep-awake` spec folders; coturn added to `docker-compose.ci.yml`.

## Exit gate
Guest open-join vertical slice green in all receiver projects; approval, protected-mode, Remove/Block, and race tests green; all rate-limit and lifetime tests green; no signaling or file metadata reachable before `JOINED` (negative test); keep-awake tests green; report written.
