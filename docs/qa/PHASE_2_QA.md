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
| Tests: snapshot vs size checks; exact `cx_rx`; IDOR; "Join within" | P2 | Snapshot deferral recorded (moved to `docs/TESTING_AND_CI.md` §3 in round 2, target Phase 3); exact message asserted; IDOR HTTP table; JoinPreview unit tests (last-minute hint, expired window, lapsed ticket) |
| i18n: sentence fragments, unlocalized `too_many_open_sessions`, unmapped `own_session` | P2 | `product.wants_to_join`, `product.too_many_open`, `product.own_session` |
| Link after Stop accepting said "expired" | P2 | Window state is checked before token revocation: `session_not_accepting` |
| Lapsed 5-minute ticket expired the preview while the code was valid | P2 | The preview keeps its source (code or link) and renews the ticket on Receive |
| "10 pending requests" unreachable | P2 | Removed; docs say requests count toward the five slots |
| SECURITY_MODEL header and TURN row; `.env.example` flag; nested `join_window` in API.md; IP-keyed join and TURN limits | P2 | Fixed; joins also limited per IP (30/min), TURN per IP (120/h) |
| RX-5 overflow at 390 px with the Refused pill | P2 | Pill wraps; mobile spec asserts no horizontal scroll on the waiting screen |
| Visual deltas (banner position, QR frame and center mark, filled copy button, countdown pill, RX-5 icon colors) | P2 | Partly: banner position, center mark, copy button and icon colors done; the rest and two broken spacing classes were found in round 2 and fixed there |
| Countdown live region every second | P2 | Not changed in this round (found again in round 2, fixed there) |
| Leave swallowed errors; lockout map pruning | P2 | Error banner on failure; expired lockouts pruned in the maintenance tick |
| No unit test for release on leave/remove | P2 | Covered by the controller test (`setActive(false)` releases) used by every screen on unmount |

## Round 2 — commit 8356a0a — FAIL

No P0, one P1, seven P2. All seven round-1 P1s were verified fixed, including attempts to break them (live DOM IDs after the clock moved, full database dump for addresses, metrics only on the internal listener and not through Caddy, a negative control for the coturn test). CI run 42800623094 on 8356a0a was green in all 12 jobs; Firefox passed only with retries.

### Resolution of round 2 findings

| Finding | Severity | Resolution |
|---|---|---|
| `gap-5` and `p-5` generate no CSS (token spacing scale), breaking the share panel spacing and the empty receivers state | P1 | Replaced with `gap-[18px]` and `p-[20px]`. New unit test `src/styles/classes.test.ts` fails on any numeric spacing utility outside the token keys (verified to catch `gap-5`, `p-5`, `h-10`) |
| Firefox e2e green only through retries (page `load` timeouts on fresh contexts) | P2 | Helpers wait for `domcontentloaded` and then for elements (single-page app); traces and reports are now uploaded on every e2e run, so retried tests can be diagnosed. Root cause tracked in the backlog |
| Countdown live region announced every second | P2 | `role="timer"` with `aria-live="off"`; a separate polite region announces only at 1:00 and 0:30 |
| Visual deltas: countdown bar, RX-5 icon, RX-5 banner width, QR frame | P2 | Full-width `surface-2` countdown bar; 72 px pulsing circle (no animation with reduced motion); banner spans the content width; QR frame 12 px padding and 14 px radius |
| Stale report lines | P2 | Fixed (pending requests, 72 h, lockout hook, screen IDs, counts, backlog, CI runs) |
| Stale owner and test docs | P2 | TESTING_AND_CI pending cap, ARCHITECTURE test hooks, SECURITY_MODEL §8 participants, UX_SCREEN_MAP TR-4 Stop accepting |
| F15 filed as a design deviation | P2 | Moved to `docs/TESTING_AND_CI.md` §3 and the phase file, target Phase 3 |
| `session-ended` never asserted | P2 | Keep-awake granted spec asserts it |

## Round 3 — commit c6e1fd2 — FAIL

No P0, two P1, five P2. Backend, protocol and CI were clean (run 42802588370 on c6e1fd2: 12/12 jobs green, Firefox with 2 flaky tests). The round-2 spacing fix was verified, but a Tailwind-backed scan of `web/src` found more classes that generate no CSS, and real spacing narrowed the code column enough to expose a line-height bug.

### Resolution of round 3 findings

| Finding | Severity | Resolution |
|---|---|---|
| Session code wraps to two overlapping lines at about 1100 px and 1280 px (40 px font on the inherited 24 px line-height) | P1 | Design values `text-[clamp(30px,4vw,38px)]` with `leading-[1.2]` and `whitespace-nowrap`. `e2e/pairing/layout.spec.ts` asserts one line, line-height ≥ font size and no horizontal scroll at 360, 390, 760, 1099, 1280, 1440 and 1920 px |
| Join request card: `bg-warning-soft/40` generates no CSS, and the card did not match the design (blue border, blue-soft fill, 16 px padding, 14 px radius) | P1 | Card uses `border-send bg-send-soft p-4 rounded-lg` as in the design; the layout spec compares its computed colors with the tokens. The regex guard is replaced by a test that asks Tailwind itself (`getClassOrder` with `tailwind.config.ts`) whether each class-like candidate in `web/src` generates CSS. It covers every scale (spacing, colors and opacity modifiers, font size, radius, shadow, breakpoints), and a self-test proves it rejects `gap-5`, `h-px`, `bg-warning-soft/40` and `md:flex` |
| `h-px w-px` on the hidden file input generate no CSS | P2 | `h-[1px] w-[1px]`; the `px` allow-list is gone with the old guard |
| Firefox flakiness not resolved | P2 | Diagnosis from the uploaded trace: `/receive` returned 200 in 2 ms, all assets and API calls completed and the app rendered, but Playwright's Firefox driver never reported `domcontentloaded`, so `goto` waited 30 s. The specs moved to an `open()` helper bounded at 10 s. Round 4 showed this did not remove the flakes and could swallow a navigation; see round 4 |
| QR frame used `rounded-[14px]` instead of the `rounded-lg` token | P2 | Reverted to `rounded-lg` |
| receive-wait: device name not bold, less space above the icon | P2 | Name in bold (`<b>` inside the translated sentence) and 32 px top padding |
| Countdown announcement used exact-second equality | P2 | `ExpiryAnnouncer` announces when the countdown crosses 1:00 or 0:30, even when ticks are skipped, and clears for a new window; unit and component tests added |

## Round 4 — commit b14a592 — FAIL

No P0, one P1, four P2. CI run 42805131808 on b14a592: 12/12 jobs green, Firefox with 2 flaky tests. All other round-3 resolutions were verified.

### Resolution of round 4 findings

| Finding | Severity | Resolution |
|---|---|---|
| `whitespace-nowrap` on the code squeezed the copy button to 18–23 px at 1060–1099 and 1260–1320 px, and the row overflowed the card at 1060 and 1260 px | P1 | Follows the design: the code may break between its two groups of three (line-height 1.2, `min-w-0`) and the copy button is `flex-none`. The layout spec now checks at 11 widths (360–1920, including 1060, 1099, 1260, 1280, 1300, 1320) that the lines never overlap, the button is at least 44 × 44 px and the code row stays inside the card content box |
| Firefox flake not fixed; `open()` could swallow a navigation that never happened (origin-only check) | P2 | `open()` now asserts the target URL (a join link may end on `/join/preview`) and the app shell, so a missing navigation fails the test. On a commit timeout it navigates once more and annotates the test (`navigation-retry`). `docs/TESTING_AND_CI.md` §3 and the report call this a mitigation, not a root-cause fix; zero flakes over several CI runs stays in the backlog |
| Class guard dropped `md:flex`, `sm:block`, bare `rounded` and `shadow`, and arbitrary variants; the self-test bypassed the filter | P2 | Candidates with variants are checked by their base utility, bare single-word utilities whose default disappears are checked, and arbitrary variants such as `[&>svg]:h-5` pass the filter. The self-test runs a synthetic source through the same extract-and-filter path and expects exactly the ten bad classes in it (`text-sm`, `lg:hidden`, `rounded`, `[&>svg]:h-5`, ...) |
| Request card: icon tile, text sizes, Approve and Reject size | P2 | 44 px `surface` icon tile with 12 px radius, 15/13 px name and platform, equal-width 44 px Approve and Reject (Block, a PRD addition, is 44 px in the request card too) |
| receive-wait sentence: the design bolds the receiver's own device; paragraph width; security words alignment | P2 | Sentence is now "{name} needs to approve **{device}** …" (EN and VI) with this device's name in bold, `max-w-[400px]` and line-height 1.55; security words are centered |
| Mobile session: QR left-aligned | P2 | QR is centered below the 760 px breakpoint |

## Round 5

Pending.
