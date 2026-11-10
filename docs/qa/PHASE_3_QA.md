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
| Firefox CI flake with the old "no ICE" symptom | P1 | **Root cause:** reproduced outside the app with a bare `RTCPeerConnection`. In about a third of stock Firefox instances under automation, every page after the first never gathers a candidate, for the rest of that browser's life; reloads, new contexts and prefs (`network.process.enabled`, `mtransport_process`, Fission, `default_address_only`) do not help, while the first page of a fresh browser always gathers. **Fix:** each Firefox receiver gets its own fresh browser (`receiverPage`, `closeReceiverBrowsers`); `docs/TESTING_AND_CI.md` §3 |
| Pause shown while unreachable | P2 | Only Retry and Cancel in that state |
| Unreachable chip says "Failed" | P2 | Neutral "Waiting" chip |
| `regrant()` without try/catch | P2 | Errors show a notice and the button recovers |
| Keep-awake released when leaving the transfer screens | P2 | Each controller holds the keep-awake controller while its transfer is active, whatever page is showing |
| iOS hint `hint_ios_lock` missing on Web | P2 | Not applicable: `docs/UX_SCREEN_MAP.md` §11 lists the hints for the native apps; the Web column has the Wake Lock states, and RX-5b already warns iOS browsers to keep the page open |
| Fatal error keeps bitmaps of removed partial files | P2 | The progress record goes with its staging file |
| Stale docs (`API.md` `not_verified`, report CI pointer, "§ round 2 evidence", nightly 42839647096 unlinked) | P2 | Corrected |
| G11 "matches the design" | P2 | Removed |
| Save-location radiogroup without arrow keys | P2 | Arrow keys move the choice (roving tab stop) |

## Round 3

Pending.
