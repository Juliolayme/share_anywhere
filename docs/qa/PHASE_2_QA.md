# QA — Phase 2

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## Round 1 — commit 49efca8 — FAIL

No P0. Seven P1 and seventeen P2 findings. The backend logic was confirmed correct with tests and live probes (open join, approval, protected mode, five-receiver race, Block by device and /64, join window, TURN authorization, IDOR probes, WebSocket relay scope, coturn allocation by hand). Local checks all passed; CI run 42797239669 was green except `e2e-web (ios-safari)`, still installing browsers when reviewed.

### Resolution of round 1 findings

| Finding | Severity | Resolution |
|---|---|---|
| P1-1 Screen IDs: TR-4 expired state never emitted `session-expired`; receiver outcomes used unrecorded IDs | P1 | Sender: `session-full`, `session-expired` (code expired or not accepting), `session-approved`, `session`. Receiver: declined is `receive-wait`; removed, blocked, left, closed, expired are `receive-done`; link resolution is `receive-preview`. The two Web-only states (`receive-joined`, `session-ended`) are recorded in UX_SCREEN_MAP §12 and deviation F14. Specs assert the IDs |
| P1-2 Routes contradicted UX_SCREEN_MAP and the PRD Universal Link path | P1 | UX_SCREEN_MAP RX-2/3/5/7 and the PRD now use `/receive`, `/j/:token`, `/receive/:sessionId` |
| P1-3 Raw client addresses stored in PostgreSQL | P1 | Migration 0004 renames to `ip_hash` and drops stored values; participants and blocks store HMAC(server key, IPv4 or IPv6 /64). Test asserts no raw value is stored. SECURITY_MODEL §8 and ARCHITECTURE §8 updated |
| P1-4 Protected-mode metrics missing | P1 | `internal/platform/metrics` (Prometheus text) on an internal listener `SA_METRICS_ADDR` (`GET /metrics`); counters for sessions created, joins, requests, blocks, failed lookups, lockouts, protected-mode activations and seconds, and a protected-mode gauge. Unit tests |
| P1-5 Required backend tests missing | P1 | Added: Create new code rate limit; session creation IP limit; 72 h signed-in lifetime and 5 open sessions; link admits at 9:59; renew after Remove; signaling after expiry; tickets revoked by renew and Stop accepting; coturn allocation test (valid, wrong secret, expired) run in the CI `compose` job against the stack's coturn (passes locally); HTTP IDOR table for close, renew, PATCH, leave, remove, approve |
| P1-6 No locked-out e2e spec | P1 | Test-build hook `POST /v1/_test/lockout` (device level) and a spec asserting "Too many attempts. Try again in 30:00." |
| P1-7 Vacuous wake-lock release assertion | P1 | No reload: the spec waits for `SESSION_UPDATED` to switch to `session-expired` and asserts exactly one more `release()` |
| Tests: snapshot vs size checks; exact `cx_rx`; IDOR; "Join within" | P2 | Snapshot deviation recorded (F15); exact message asserted; IDOR HTTP table; JoinPreview unit tests (last-minute hint, expired window, lapsed ticket) |
| i18n: sentence fragments, unlocalized `too_many_open_sessions`, unmapped `own_session` | P2 | `product.wants_to_join`, `product.too_many_open`, `product.own_session` |
| Link after Stop accepting said "expired" | P2 | Window state is checked before token revocation: `session_not_accepting` |
| Lapsed 5-minute ticket expired the preview while the code was valid | P2 | The preview keeps its source (code or link) and renews the ticket on Receive |
| "10 pending requests" unreachable | P2 | Removed; docs say requests count toward the five slots |
| SECURITY_MODEL header and TURN row; `.env.example` flag; nested `join_window` in API.md; IP-keyed join and TURN limits | P2 | Fixed; joins also limited per IP (30/min), TURN per IP (120/h) |
| RX-5 overflow at 390 px with the Refused pill | P2 | Pill wraps; mobile spec asserts no horizontal scroll on the waiting screen |
| Visual deltas (banner position, QR frame and center mark, filled copy button, countdown pill, RX-5 icon colors) | P2 | Matched to the design |
| Countdown live region every second | P2 | Removed |
| Leave swallowed errors; lockout map pruning | P2 | Error banner on failure; expired lockouts pruned in the maintenance tick |
| No unit test for release on leave/remove | P2 | Covered by the controller test (`setActive(false)` releases) used by every screen on unmount |

## Round 2

Pending.
