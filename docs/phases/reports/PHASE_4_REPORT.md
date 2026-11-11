# Phase 4 report: multi-receiver, reconnect and resume hardening

Status: implemented; QA rounds 1–6 failed, all P0/P1 findings fixed; round 7 pending (`docs/qa/PHASE_4_QA.md`). Everything here is guest-only and Web-only; Android and iOS come in Phases 6 and 7.

## 1. What was implemented

**Implemented and tested**

- **Sender scheduler and shared block cache** (`web/src/features/transfer/engine/cache.ts`, `docs/TRANSFER_PROTOCOL.md` §5.1).
  - Each receiver keeps its own connection, window, flow control, bitmap and retries, so a slow receiver waits only on its own channel.
  - The connections share one LRU block cache (64 MiB default, `VITE_BLOCK_CACHE_MB`): a cached block is read and hashed once, and concurrent requests share that read. Receivers moving together read the file once.
  - Vitest: cache bounds and LRU order, shared reads, a slow receiver not holding back a fast one, three receivers reading the file once.
- **Dashboard (TR-6)**: per-receiver Pause/Resume, Remove and **Block** (confirmation names the receiver; a blocked card shows Blocked), Stop all, Close session, aggregate progress and a **group ETA** that follows the slowest active receiver (PRD §6.5). Ended receivers stay listed once a transfer to them began, so the sender sees what happened.
- **Session end and result** (`backend/internal/sharing/aggregate.go`, `docs/ARCHITECTURE.md` §4.5).
  - A live session never ends by itself after delivering: after the join window or Stop accepting, the sender can still Create new code and admit late receivers. Only Close (CLOSED) or the idle or maximum lifetime ends it.
  - When a lifetime ends it, `EndStatus` records the result: COMPLETED (every counted transfer completed), PARTIALLY_COMPLETED (some), or EXPIRED (nothing delivered). JOINED and LEFT receivers count; removed and blocked ones count only if they had already received every file.
  - TR-7 and RX-7 come from each client's own transfers, with the same counting rule on the sender (`finalOf`). While the session is live the sender's result is provisional: a late receiver brings back TR-6, and the History entry is rewritten when the result changes.
  - TR-7 "New transfer" closes the finished session (confirming while the window is open); "Back to the session" leads to the code and Create new code. If the sender leaves another way and Create later hits the open-session cap, the send screen lists the device's open sessions (`GET /v1/sessions`, new) with Open and Close.
  - The sender's result counts files, like the server and the receiver: one file of two is partial.
  - Only the tab with the picked files serves receivers and writes History (Web Lock); another tab of the same device on that session leaves offers to it, says another tab is sending, and mirrors the progress (no Pause or Resume, speed or ETA there). Deleted History entries stay deleted across tabs and reloads for 7 days.
  - Tests: the rule over every combination of receiver and transfer states (576,601 inputs), and database scenarios: delivery then window expiry (session live, Renew, late receiver completes), idle end completed/partial/expired, removed and blocked excluded, max lifetime mid-transfer, Close, lifetime end racing final reports.
- **Cleanup**: the maintenance job cancels orphan transfers (ended session or departed receiver) and counts them; purge on the existing 7-day schedule, now tested. Transfer reports lock the session row before the transfer row, serializing them with Remove, Leave, Close and the lifetime end.
- **Reconnect hardening**: receiver redial backoff with ±25 % jitter (tested); the WebSocket already reconnects with jitter and a fresh one-time ticket; bitmap exchange and duplicate tolerance unchanged from Phase 3.
- **History (PRD §5.6, guest)**: All/Sent/Received tabs, search across title, peers and file names, status/date/device filters, HI-2 detail drawer at `/history/:id`, delete one entry, clear all, retention sweep on open, empty/no-results/loading/error states. Entries now record peers, files, route and start time.
- **e2e**:
  - `web/e2e/transfer/multi.spec.ts` on the desktop projects: two receivers with one slowed, where the fast one finishes first and the sender keeps the screen on until the last ends; Remove and Block mid-transfer, where the other receiver completes and a blocked device cannot rejoin; Close session, where every receiver sees it end.
  - `web/e2e/history/history.spec.ts` in all five projects.
  - Nightly `five-receivers`: three Chromium, stock Firefox and WebKit; a sixth join is refused; four finish while the slow one is still going; SHA-256 of every download.

**Implemented but untested**

- Real devices (phones backgrounded, screen off) and the TURN relay route: Phase 8 and device testing.
- The 10-minute sender reconnect window and the maintenance job's orphan cleanup on a real clock (unit and database tests only).

**Planned (later phases)**: retry for failed receivers and per-file re-download (G4/G12), cloud history sync (Phase 5A).

## 2. Usable screens and routes (Web)

TR-4/TR-5 session (reachable from TR-6/TR-7 by "Back to the session"; Create new code after a delivery is covered by backend tests, not by a browser spec), TR-6 dashboard (several receivers, Block, group ETA), TR-7 result for completed and partially completed sessions, RX-5b/RX-6/RX-7, History HI-1 list and HI-2 detail (`/history`, `/history/:id`).

## 3. End-to-end workflows executed (guest)

| Workflow | Where |
|---|---|
| Two receivers, one slowed; screen held until the last ends | CI and locally: chromium-desktop, firefox-desktop (stock 160), webkit-desktop |
| Remove and Block mid-transfer; blocked device cannot rejoin; sender result stays completed | Same |
| Close session ends every receiver | Same |
| A receiver joins after the result: TR-6 returns, then New transfer closes the session (code refused) and both receivers keep RX-7 | CI [42920840711](https://github.com/Juliolayme/share_anywhere/actions/runs/42920840711) and locally: chromium-desktop, firefox-desktop, webkit-desktop |
| Five receivers (3 Chromium, Firefox, WebKit), sixth join refused with 409 `session_full` | Nightly [42934227170](https://github.com/Juliolayme/share_anywhere/actions/runs/42934227170) on 7e43912 (final code), earlier [42913806192](https://github.com/Juliolayme/share_anywhere/actions/runs/42913806192) (06e9211) and [42916660410](https://github.com/Juliolayme/share_anywhere/actions/runs/42916660410) (546873f, with the strict sixth-join check); locally |
| History search, filters, detail, delete, clear | CI and locally: all five projects |
| A second tab of the sender on the same session (no files) leaves the transfer to the tab with the files; the receiver completes, hash verified | CI [42934218432](https://github.com/Juliolayme/share_anywhere/actions/runs/42934218432): chromium-, firefox-, webkit-desktop (also checks the other-tab notice and the stored History entry); locally the same three |
| Open-session cap reached: the send screen lists open sessions; Close one, then Create succeeds; Open goes to the session | CI [42925255350](https://github.com/Juliolayme/share_anywhere/actions/runs/42925255350): all five projects; locally: chromium-desktop, firefox-desktop, webkit-desktop |
| Phase 3 transfer and pairing specs (including Create new code after expiry) | CI and locally: all five projects |

## 4. Commands and results

| Command | Result |
|---|---|
| `go vet ./...`, `golangci-lint run ./...` | Clean, 0 issues |
| `go test -race -count=1 ./...` with the test database | All packages pass (sharing 24, transfers 20 top-level tests, none skipped) |
| `pnpm -C web format:check`, `lint`, `exec tsc -b`, `test --run` | Pass; 184 unit tests |
| `pnpm protocol:check`, `i18n:check`, `tokens:check`, `lint:md` | Pass (32 operations; 1,800 keys each) |
| Playwright, all five projects locally (ac7a284) | 197 passed, 61 skipped (project-specific); the 2 Android screenshot comparisons differ by local fonts (baselines are made on the runner) |
| CI | [42934218432](https://github.com/Juliolayme/share_anywhere/actions/runs/42934218432) on 7e43912: green, every e2e project passed on the first attempt (chromium 45, firefox 44, webkit 45, android-chrome 38, ios-safari 38). [42930065900](https://github.com/Juliolayme/share_anywhere/actions/runs/42930065900) on d6d6aae: green, every e2e project passed on the first attempt (chromium 45, firefox 44, webkit 45, android-chrome 38, ios-safari 38). [42925255350](https://github.com/Juliolayme/share_anywhere/actions/runs/42925255350) on b8b4405: green, and every e2e project passed on the first attempt (no test needed a retry: chromium 44, firefox 43, webkit 44, android-chrome 38, ios-safari 38 passed). On b247af7, [42920840711](https://github.com/Juliolayme/share_anywhere/actions/runs/42920840711) was green, but the new late-receiver spec passed only on retry on chromium-desktop and webkit-desktop (QA round 3; fixed in 0c4a20d). [42916941586](https://github.com/Juliolayme/share_anywhere/actions/runs/42916941586) on ac7a284: all 12 jobs green. Earlier: 42913806193 on 06e9211 (non-e2e green; four e2e jobs cancelled by the next push) |
| Nightly | [42934227170](https://github.com/Juliolayme/share_anywhere/actions/runs/42934227170) on 7e43912 (final code): five-receivers, large-file, mobile-snapshots green. [42930065834](https://github.com/Juliolayme/share_anywhere/actions/runs/42930065834) on d6d6aae: five-receivers, large-file, mobile-snapshots green. [42924813119](https://github.com/Juliolayme/share_anywhere/actions/runs/42924813119) on 0c4a20d (after the e2e cleanup change), [42920858447](https://github.com/Juliolayme/share_anywhere/actions/runs/42920858447) on b247af7 (dispatched on the branch), [42913806192](https://github.com/Juliolayme/share_anywhere/actions/runs/42913806192) and [42916660410](https://github.com/Juliolayme/share_anywhere/actions/runs/42916660410): five-receivers, large-file and mobile-snapshots green |

## 5. Environment variables and external services

Unchanged from Phase 3. New: `VITE_BLOCK_CACHE_MB` (optional, build time, in `.env.example` and the web image; at least one 4 MiB block); nightly `E2E_FIVE=1` for the five-receiver job.

## 6. Known limitations and untested behavior

- Phase 3 limitations still apply, including Firefox's default-route mode (a Firefox receiver that reloads, or one on a LAN without internet, may get no candidates; untested).
- A receiver that falls more than the cache budget behind the others reads its blocks from the file again (by design).
- Orphan transfers cancelled by the maintenance job send no TRANSFER_UPDATED (their participants are gone or the session has ended).
- History "Send again" is not offered on the Web (G16).
- A partial send's History integrity line says "not verified" even when some receivers verified the file (the design has no third string; G17).
- The fairness unit test runs on real timers, not a simulated clock (TRANSFER_PROTOCOL §5.1).

## 7. Backlog

| Priority | Item |
|---|---|
| P0 | — |
| P1 | Firefox default-route mode (from Phase 3); retry for failed receivers and per-file re-download (G4/G12) |
| P2 | Remove/Block/Reject on an ended session are still accepted (harmless, documented); sender notice for auto-declined receivers; History integrity wording for partial sends; about 150 product keys from Phases 2–3 not listed in the DESIGN_DEVIATIONS E-table; a browser spec for Create new code after a delivery; a `TransferDashboard` component test for the New transfer branches; a message for a receiver whose WebSocket upgrade keeps being refused; receivers redial without an answer while the tab with the files has no socket (TRANSFER_PROTOCOL §5.1) |

## 8. Local run

`docker compose up --build`, then open `https://localhost:8443` in up to six browser profiles: one sends, up to five receive. The sender's dashboard shows every receiver; History lists the result on each device.

## 9. Commits

| Commit | Summary |
|---|---|
| a264916 | Phase 3 closed (QA PASS) |
| 08ab0c7 | Backend: session aggregate, orphan cleanup, lock order |
| d5cacae | Web: History search, filters, detail, delete, retention |
| 06e9211 | Shared block cache, group ETA, Block on TR-6, multi-receiver e2e, nightly five-receivers |
| 595be07 | Report draft |
| 546873f | QA round 1 Web fixes (result counting, Blocked chip, cache setting, tests) |
| ac7a284 | QA round 1 P0: a live session ends only by Close or its lifetime |
| 823e67e | QA round 1 record, report links |
| b247af7 | QA round 2: provisional sender result, New transfer closes a finished session, session-end cleanup |
| dd5e363 | Report links |
| 0c4a20d | QA round 3: e2e context cleanup, result over files, History times |
| b8b4405 | QA round 3: open-sessions list when the cap is reached (`GET /v1/sessions`) |
| 50a13c8 | Report links |
| d6d6aae | QA round 4: only the tab with the files serves receivers (Web Lock); History remembers deletions; panel focus and strings; download retries |
| b367853 | Report links |
| 7e43912 | QA round 5: the mirroring tab writes no History and says another tab is sending; pending lock counted; deleted-id expiry |
| e940ee0 | Report links |
