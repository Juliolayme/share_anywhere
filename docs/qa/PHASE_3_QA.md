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

## Round 4

Pending.
