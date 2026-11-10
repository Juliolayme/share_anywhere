# QA — Phase 3

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## Round 1 — commit ceb4d0b — FAIL

2 P0, 3 P1, 13 P2 findings.

**What held up under review:**

- the backend, the engine core, data integrity (ACK only after write, verify and persist; resume by bitmap) and the test hooks;
- the Chromium and WebKit e2e runs;
- the production build, which carries none of the `__saTest` / pace / corrupt / drop hooks;
- nightly 2 GB runs 42824525884, 42825463463 and 42827720405, all green.

**Why it failed:**

- the required `web` check was red;
- the Firefox receiver never connected;
- the report was wrong in places;
- received data was never removed from browser storage;
- some design differences were unrecorded.

### Resolution of round 1 findings

| Finding | Severity | Resolution |
|---|---|---|
| `web` check red: Prettier on `src/i18n/catalog-*.ts` and `keys.test.ts` | P0 | Formatted; `format:check` passes |
| Firefox receiver never connects | P0 | **Root cause:** Playwright's patched Firefox build never gathers an ICE candidate. The attached diagnostics show "ice failed" on every attempt with no candidates, while the Chromium sender gathers host, srflx and relay candidates. Stock Firefox 160 gathers normally.<br>**Fix:**<ul><li>The `firefox-desktop` project drives a stock Firefox over WebDriver BiDi (`channel: 'moz-firefox'`, `E2E_FIREFOX_BIN`). CI downloads a pinned, checksum-verified Firefox 160.0.</li><li>The sender's Chromium launch sets its own channel and executable, since the project's options otherwise applied to it too.</li><li>Codes and names are typed key by key, because BiDi `fill()` does not update React inputs.</li></ul>Locally the whole Firefox project passes on the current build. Round 2 found a second, browser-wide Firefox fault (below) |
| Report claims wrong; nightly run not linked | P1 | Report rewritten: nightly and CI runs linked, bundle size, format check, baselines committed, commit list |
| Received data never removed from OPFS | P1 | <ul><li>Partial data is removed when a transfer fails, is cancelled, or the receiver is removed.</li><li>A finished file stays in browser storage for 24 hours, so it can be downloaded again; RX-7 says so.</li><li>`storage/sweep.ts` runs once per tab. It removes progress records untouched for 24 hours with their staging files, and staging files no record refers to after an hour. Unit test added.</li><li>Lifecycle documented in `docs/TRANSFER_PROTOCOL.md` §4.</li></ul> |
| TR-6 / TR-7 / RX-6 differences not recorded | P1 | TR-7 heading now shows the outcome and done bars stay blue, as in the design. Sub-heading without the code, route chip wording, and RX-6 Details and security words recorded as G8–G10 (G11 was dropped in round 2: it matched the design) |
| FILE_META not checked against server records | P2 | `prepare()` fails with `protocol` when file ID or size differ from the session's files |
| Capability requirement bypassable through `/report`; sender could report | P2 | Server refuses reports from the sender (`403 receiver_only`) and reports that would leave `PAUSED` for an active state (`409 use_resume`); tests and `docs/API.md` updated |
| No drift test for the state machine mirror | P2 | `shared/protocol/schemas/transfer-states.json`, asserted by a Go test and a Vitest test |
| Unlimited retries with misleading text | P2 | <ul><li>Reconnect window: 2 minutes to make a first connection, 10 minutes to get one back.</li><li>After that RX-6 shows "Couldn't reach the sender" with Retry, and nothing is reported as failed.</li><li>"Connecting to the sender…" is shown before any data arrives.</li></ul> |
| Hard-coded "SHA-256" fragment, ETA units, waiting chip wording | P2 | `product.verifying_sha`, `product.eta_hm/eta_ms/eta_s`, `product.st_waiting` (EN/VI) |
| "Queued" contrast 4.34:1 | P2 | `text-fg-2` |
| Dashboard ignores the open join window for keep-awake | P2 | Held while the window is open (server time) or transfers run |
| Fragile keep-awake composition | P2 | The controller counts holders (`hold(symbol, needs)`); unit test for parent and child |
| Silent failures, no Retry | P2 | Remove and Close errors show a banner, and Close no longer navigates on failure; Retry on the RX-6 and TR-6 load failures; the permission fallback has a catch |
| Snapshot does not mask the random sender name | P2 | `preview-sender` masked; baseline regenerated on the runner |
| Sender wake release not asserted after pause and cancel | P2 | Both asserted (the cancel spec ends the join window first) |
| `.env.example` missing `VITE_TEST_HOOKS` | P2 | Added |
| Stale docs (`folder.ts` F16, `MODE === 'test'`, baselines line, TR-6 "Pause all") | P2 | Corrected |
| Firefox pairing specs flaky (carried over) | P2 | Firefox now runs as stock Firefox over BiDi; to be confirmed over several CI runs (backlog) |

## Round 2 — commit e29c0a2 — FAIL

2 P0, 3 P1, 10 P2 findings. Round 1 fixes were confirmed in code. Backend (`go vet`, `go test -race`, golangci-lint), web format, lint, types, 108 unit tests, build, protocol, i18n and token checks all passed.

### Resolution of round 2 findings

| Finding | Severity | Resolution |
|---|---|---|
| `e2e-web (android-chrome)` red: `receive-preview` snapshot differs | P0 | The random sender name's length decided whether the Guest badge wrapped, which moved the card. The snapshot spec now renames the sender's device to a fixed name first (`renameDevice()`); baselines regenerated on the runner |
| Receiver reload mid-transfer leaves the transfer `PAUSED`; both sides show Paused and drop the wake lock; sender gets no TR-7 or History | P0 | **Cause:** the client's state walker went `TRANSFERRING → PAUSED → CONNECTING`, and the round-1 `use_resume` rule refused every later step.<br>**Fix:**<ul><li>`pathTo` never passes through `PAUSED` and never leaves it by report (only to a terminal state); a test walks every pair against the server's rule.</li><li>If a report finds the server `PAUSED` while nobody paused locally, the reporter calls the resume action with the capability first.</li><li>The sender reaches TR-7 as soon as the receiver confirms every file hash.</li><li>The reload spec now asserts: bytes keep moving, the receiver's pill stays on with no release, the sender's card never shows paused, TR-7 completed live and after a reload (rebuilt from server records), and the sender's History entry. The nightly 2 GB spec checks the sender's outcome too.</li></ul> |
| Pause while connecting or reconnecting is undone by the pending retry | P1 | `pause()` cancels the retry timer and any pending dial; `connect()` stays put while paused; a channel that opens while paused is paused at once; Resume restarts the reconnect window. Unit tests (`receiver-controller.test.ts`) cover reload, pause during reconnecting, and the resume hook |
| RX-7 per-file integrity failure not built or recorded | P1 | Recorded as G12 (per-file retry needs a new transfer record, the same work as G4, Phase 4 backlog; the design strings name sample files) |
| Firefox CI flake with the old "no ICE" symptom | P1 | **Root cause (local):** the container's system proxy, picked up by Firefox from the environment. With it, Firefox stops gathering ICE candidates on every page after the first, a reload included; reproduced with a bare `RTCPeerConnection` outside the app, gone with `network.proxy.type = 0` or without the proxy variables (0 failures in 24 browsers, against about a third before). **Fix:** the Firefox project sets `network.proxy.type = 0`, and each Firefox receiver gets its own fresh browser. The CI runner has no proxy, so the CI occurrence is watched over the next runs |
| Pause shown while unreachable | P2 | Only Retry and Cancel in that state |
| Unreachable chip says "Failed" | P2 | Neutral "Waiting" chip |
| `regrant()` without try/catch | P2 | Errors show a notice and the button recovers |
| Keep-awake released when leaving the transfer screens | P2 | Each controller holds the keep-awake controller while its transfer is active, whatever page is showing |
| iOS hint `hint_ios_lock` missing on Web | P2 | Not applicable: `docs/UX_SCREEN_MAP.md` §11 lists the hints for the native apps; the Web column has the Wake Lock states, and RX-5b already warns iOS browsers to keep the page open |
| Fatal error keeps bitmaps of removed partial files | P2 | The progress record goes with its staging file |
| Stale docs (`API.md` `not_verified`, report CI pointer, "§ round 2 evidence", nightly 42839647096 unlinked) | P2 | Corrected |
| G11 "matches the design" | P2 | Removed |
| Save-location radiogroup without arrow keys | P2 | Arrow keys move the choice (roving tab stop) |
| Found while verifying: a receiver page closed mid-write could send a fatal storage error to the sender, which then showed the receiver as Failed although the next load resumed | — | The receiver suspends on `pagehide`: it closes the connection first, so errors from storage torn down with the page are neither sent nor reported; it reconnects if the page returns from the back-forward cache. Unit test added |

## Round 3 — commit 385b20e — FAIL

0 P0, 3 P1, 5 P2. Every round-2 fix was confirmed in code and tests. Backend, web format, lint, types, 114 unit tests, production build, protocol, i18n and token checks passed. The transfer specs passed on chromium, firefox (stock 160) and webkit, plus both mobile projects. CI 42849540806 was green apart from the then-stale mobile baselines.

### Resolution of round 3 findings

| Finding | Severity | Resolution |
|---|---|---|
| After a receiver pause and a resume over a new connection, the sender stayed "Paused" and released its wake lock while bytes flowed | P1 | A `TRANSFER_UPDATED` that leaves `PAUSED` moves the sender's card back to transferring (or reconnecting without a channel). A new connection takes its paused state from the server record, so a pause by either side survives a reconnect (the sender pauses the new connection). New e2e on every desktop engine: receiver pauses, reloads and resumes; the sender card goes `transferring` and its wake lock is requested again |
| Pause during verification left the server record `PAUSED` while both sides showed completed | P1 | The receiver may report `PAUSED → COMPLETED` with every byte verified (state table, shared `transfer-states.json`, Go and Vitest tests, ARCHITECTURE §4.5, API, TRANSFER_PROTOCOL §7). Pause is no longer offered while verifying (nothing is left to send), and a sender pause at that point still ends `COMPLETED` |
| RX-6 and TR-6 bar colors differ from the design | P1 | `barTone()` follows the design's `BAR` map on both screens: grey paused, green verifying and done, amber reconnecting, red failed. Unit test |
| Resume hook could override a sender's pause after Choose, Permission or Unreachable | P2 | `start()` and `retry()` stay paused when the server says so; a sender pause while unreachable moves the receiver to paused |
| Sender held the wake lock indefinitely for a receiver that never returned | P2 | Sender reconnect window of 10 minutes, like the receiver's, then the card shows Waiting and stops holding the screen; a new connection picks the transfer up |
| Stale report lines | P2 | Unit test count, CI and nightly runs, commit hashes |
| Docs said production images never include the hooks | P2 | Reworded: the hooks cannot be reached without `VITE_TEST_HOOKS`; the code is still in the bundle |
| Accessible names built by concatenation | P2 | `product.rx_download_named`, `product.pause_named`, `product.resume_named` (EN/VI) |

## Round 4 — commit 1730861 — FAIL

0 P0, 4 P1, 5 P2. The round-3 behaviour fixes held: backend, web checks, 116 unit tests, protocol, i18n, tokens and markdown passed. The transfer specs passed on chromium, firefox and webkit plus both mobile projects. QA scenarios A–D (sender pause across a receiver reload, pause while reconnecting, receiver pause across a sender drop, sender pause while verifying) passed on three engines. CI 42858451466 on 1730861 was green in all 12 jobs.

### Resolution of round 4 findings

| Finding | Severity | Resolution |
|---|---|---|
| No Pause while verifying not recorded as a deviation | P1 | G13 |
| Bar colors still off on the TR-6 matrix and TR-5 rows | P1 | Matrix cells red for a failed receiver and amber while reconnecting; TR-5 rows use `barTone` |
| After the sender's reconnect window TR-5/TR-6 said "Waiting for the receiver to choose where to save" | P1 | New `offline` status with its own chip ("Offline") and text ("Lost contact. They can reconnect while this page stays open"), EN/VI, Remove still offered; G14; fake-timer unit tests |
| Red required Firefox run on 385b20e left out of the report | P1 | Recorded in the report (CI row, §6 known limitation, P1 backlog) as an open intermittent with its diagnostics. Not reproduced locally without the proxy (12 browsers × 4 reloads with live connections); not retried or quarantined. Further CI runs are listed below as they complete |
| Window not armed on every path; sender without its files still held the screen | P2 | The window is armed whenever a receiver is connecting or reconnecting without an open channel (Resume while away, server resume, after a refresh); a sender tab without its picked files does not hold the screen |
| Transfer map stale after a socket reconnect | P2 | `SOCKET_OPEN` reloads the records; unit test |
| Multi-file resume flicker | P2 | A pending resume ignores files still `PAUSED` until the server moves on |
| Unit-test gaps | P2 | `sender-controller.test.ts` (follow a resume, window to Offline, Resume while away, refresh on reconnect); receiver tests for Retry staying paused and Pause ignored while verifying; Go test asserts `not_verified` for a partial `COMPLETED` while paused |
| Sender window missing from the owner docs | P2 | ARCHITECTURE §7.1 and TRANSFER_PROTOCOL §6 |

## Round 5 — commit 7db1c5c — FAIL

1 P0, 3 P1, 8 P2. Backend, web checks, 121 unit tests, protocol, i18n, tokens and markdown passed, and every local transfer spec passed on all five projects. CI 42863480743 on 7db1c5c had 11 of 12 jobs green; Firefox was red.

### Resolution of round 5 findings

| Finding | Severity | Resolution |
|---|---|---|
| Firefox reload ICE failure recurred on HEAD (CI 42863480743) | P0 | The failure appears only in the two CI runs on commits whose receiver closed its peer connection on `pagehide` (added in 385b20e); runs before and between were green. Not reproduced locally (12 browsers × 4 reloads, with and without closing on `pagehide`). Change: the receiver no longer closes anything on `pagehide`; it mutes its connection (no frames, no reports, no reconnect) and leaves teardown to the browser, as before 385b20e. Each dial now records whether the offer was set and the gathering state. The 5 s poll in the pause spec is 30 s (ICE took about 6 s once). Report and TESTING_AND_CI record the runs; the item stays an open P1 until several consecutive Firefox CI runs are green. No retry or quarantine added |
| Resume after the receiver left while paused showed Transferring forever and held the screen | P1 | `onLost` closes and forgets the connection whatever the card says; a channel counts as live only when the peer connection is `connected`, so Resume shows reconnecting and the 10-minute window runs. Unit test with a failed peer connection |
| A sender tab without its files still held the screen on TR-5/TR-6 | P1 | Both pages hold for transfers only when `hasFiles`; after a refresh, an active record with no live channel shows reconnecting (window armed) |
| Status chips differ from the Design System | P1 | Connecting grey; Transferring `ArrowUpRight`; Receiving `ArrowDownLeft`; Partial `CircleDashed`; the TR-5 Waiting chip recorded as G15 |
| Huge ETA when throughput decays | P2 | Provisional after 10 s without bytes, and above a week; unit test |
| `refresh()` ignored PAUSED/RESUMING missed while disconnected | P2 | Without a live channel the server record sets or clears Paused |
| `resuming` never cleared on a failed resume | P2 | Cleared in the catch |
| `onLost` cleared `conn` without closing it | P2 | Closed first |
| Offline matrix cells blue | P2 | Grey, noted in G14 |
| VI "Mất kết nối" vs the design's "Ngoại tuyến" | P2 | "Ngoại tuyến" |
| UX_SCREEN_MAP TR-6 states lacked waiting and offline | P2 | Added |
| Stale report numbers | P2 | Key count, CI rows, dial timings |

## Round 6 — commit b12ac19 — FAIL

0 P0, 1 P1, 4 P2. Every round-5 fix held, with no regression. QA scenarios E–H passed on chromium, firefox and webkit:

- E: sender pause, receiver leaves, Resume.
- F: receiver leaves, sender reloads.
- G: refresh and `SOCKET_OPEN` during a live transfer.
- H: receiver navigates away and back.

The backend, web checks (123 unit tests), protocol, i18n, tokens and markdown all passed, and so did 25 local transfer specs. CI 42868022615 on b12ac19 was green in all 12 jobs; Firefox had 34 passed, 0 flaky, no retries.

### Resolution of round 6 findings

| Finding | Severity | Resolution |
|---|---|---|
| Relay route chip used the Cloud colors and the wrong icon | P1 | Relay is blue (`send-soft` / `send-ink`) with `RadioTower`; the badge is 26 px tall with a 6 px gap and 10 px padding, as in the Design System |
| Stale report numbers | P2 | Unit test count, bundle size, CI 42868022615 |
| G15 covered only TR-5 | P2 | Now TR-5 and TR-6 |
| No test locked in "mute, don't close" on `pagehide` | P2 | Controller test (no `pc.close()` on suspend; `wake()` tears down and redials) and engine test (a muted connection sends nothing) |
| Route chip stale while reconnecting | P2 | Hidden while connecting, reconnecting, unreachable or offline (G9 notes it instead of the probe badge) |

## Round 7 — commit b898abe — FAIL

1 P0, 1 P1, 2 P2. Every round-6 fix held, and so did the full-phase pass. That pass covered security (receiver-only reports, capability, authorization, rate limit, CSP, no secrets), keep-screen-on, i18n, design conformance with G1–G15, the backend, the web checks (125 unit tests), protocol, tokens, markdown and 25 local transfer specs. CI 42871975278 on b898abe was red on Firefox.

### Resolution of round 7 findings

| Finding | Severity | Resolution |
|---|---|---|
| Required Firefox job red on HEAD; same reload ICE failure, without the `pagehide` close | P0 | **Root cause found** (per-browser Firefox logs, runs 42886311449 and 42890704284 attempt 2): `PR_Connect failed: -5980` → `failed to find default addresses` → `ICE FAILED: Couldn't gather ICE candidates`. Without a camera or microphone permission Firefox gathers only its default-route address, found by a UDP route probe that fails in the reloaded page on the runner. A first guess (`localhost` resolving to `::1`) was disproved when it recurred with `127.0.0.1`. The Firefox receivers in the e2e suite now get camera and microphone permission, so Firefox gathers every interface and skips the probe; the real-user limitation (networks where the probe fails) is in the report. Confirmation over consecutive CI runs is recorded under round 8. Earlier steps: The `pagehide` link is withdrawn. CI now captures Firefox ICE logs (`MOZ_LOG`), the receiver's diagnostics across the reload, and the ICE server URLs per dial; the Firefox job is being re-run to catch a failure with those logs. Recorded as an exit-gate blocker. No retry or quarantine |
| Firefox record no longer honest | P1 | Report §4/§6/§7, TESTING_AND_CI §3 and this record state the real rate (3 of 6 recent runs, plus the e29c0a2 first-attempt failure) and withdraw the `pagehide` link |
| Stale route chip while paused with no connection | P2 | The route is cleared when the connection is lost (receiver and sender) and set again when a channel opens |
| No test covers the route chip | P2 | `ui.test.tsx`: Direct green, Relay blue at 26 px, nothing while the route is unknown |
| Found while investigating: the sender dropped every receiver candidate that arrived before its offer handler had registered the peer and applied the remote description (it awaits the session refresh and TURN credentials). Host and srflx candidates, trickled at once, were lost; only the later relay candidate survived, so in CI every connection silently depended on TURN | — | Candidates are buffered per connection id and added once the remote description is applied; unit test. The first Firefox CI run with Firefox ICE logs (31d0a6e, run 42875252812) was green but the logs went to a folder Playwright empties; they now go to `web/moz-log/` |

## Round 8

Pending.
