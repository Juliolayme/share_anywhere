# Phase 4 report: multi-receiver, reconnect and resume hardening

Status: implemented; QA and CI confirmation in progress (`docs/qa/PHASE_4_QA.md`). Everything here is guest-only and Web-only; Android and iOS come in Phases 6 and 7.

## 1. What was implemented

**Implemented and tested**

- **Sender scheduler and shared block cache** (`web/src/features/transfer/engine/cache.ts`, `docs/TRANSFER_PROTOCOL.md` §5.1).
  - Each receiver keeps its own connection, window, flow control, bitmap and retries, so a slow receiver waits only on its own channel.
  - The connections share one LRU block cache (64 MiB default, `VITE_BLOCK_CACHE_MB`): a cached block is read and hashed once, and concurrent requests share that read. Receivers moving together read the file once.
  - Vitest: cache bounds and LRU order, shared reads, a slow receiver not holding back a fast one, three receivers reading the file once.
- **Dashboard (TR-6)**: per-receiver Pause/Resume, Remove and **Block** (with the TR-5 confirmation), Stop all, Close session, aggregate progress and a **group ETA** that follows the slowest active receiver (PRD §6.5). Ended receivers stay listed once a transfer to them began, so the sender sees what happened.
- **Session aggregate** (`backend/internal/sharing/aggregate.go`, `docs/ARCHITECTURE.md` §4.5).
  - An ACTIVE session whose join window has closed, with no pending request and every counted transfer finished, becomes COMPLETED (all completed) or PARTIALLY_COMPLETED (some).
  - JOINED and LEFT receivers count; removed and blocked ones do not. A session that delivered nothing stays ACTIVE.
  - It is settled in the same transaction as the change and in the maintenance job; SESSION_UPDATED follows. The sender then opens TR-7 and each receiver its own RX-7.
  - Tests cover every combination of participant and transfer states, plus database scenarios (concurrent final transfers settle once).
- **Cleanup**: the maintenance job cancels orphan transfers (ended session or departed receiver) and counts them; purge on the existing 7-day schedule, now tested. Lock order fixed (session row before transfer row).
- **Reconnect hardening**: receiver redial backoff with ±25 % jitter; the WebSocket already reconnects with jitter and a fresh one-time ticket; bitmap exchange and duplicate tolerance unchanged from Phase 3.
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

TR-5 session, TR-6 dashboard (several receivers, Block, group ETA), TR-7 result for completed and partially completed sessions, RX-5b/RX-6/RX-7, History HI-1 list and HI-2 detail (`/history`, `/history/:id`).

## 3. End-to-end workflows executed (guest)

| Workflow | Where |
|---|---|
| Two receivers, one slowed; screen held until the last ends | Locally: chromium-desktop, firefox-desktop (stock 160), webkit-desktop |
| Remove and Block mid-transfer; blocked device cannot rejoin | Same |
| Close session ends every receiver | Same |
| Five receivers (3 Chromium, Firefox, WebKit), sixth join refused | Locally (chromium-desktop project); nightly run: pending |
| History search, filters, detail, delete, clear | Locally: all five projects |
| Phase 3 transfer specs | Locally: all five projects |

## 4. Commands and results

| Command | Result |
|---|---|
| `go vet ./...`, `golangci-lint run ./...` | Clean, 0 issues |
| `go test -race -count=1 ./...` with the test database | All packages pass |
| `pnpm -C web format:check`, `lint`, `exec tsc -b`, `test --run` | Pass; 160 unit tests |
| `pnpm protocol:check`, `i18n:check`, `tokens:check`, `lint:md` | Pass (1,785 keys each) |
| Playwright, all five projects locally | 196 passed; the 2 Android screenshot comparisons differ by local fonts (baselines are made on the runner); one WebKit "internal error" on `page.reload()` passed 3 of 3 on re-run |
| CI and Nightly | Pending (`docs/qa/PHASE_4_QA.md`) |

## 5. Environment variables and external services

Unchanged from Phase 3. New: `VITE_BLOCK_CACHE_MB` (optional, build time); nightly `E2E_FIVE=1` for the five-receiver job.

## 6. Known limitations and untested behavior

- Phase 3 limitations still apply, including Firefox's default-route mode (a Firefox receiver that reloads, or one on a LAN without internet, may get no candidates; untested).
- A receiver that falls more than the cache budget behind the others reads its blocks from the file again (by design).
- Orphan transfers cancelled by the maintenance job send no TRANSFER_UPDATED (their participants are gone or the session has ended).
- History "Send again" is not offered on the Web (G16).

## 7. Backlog

| Priority | Item |
|---|---|
| P0 | — |
| P1 | Firefox default-route mode (from Phase 3); retry for failed receivers and per-file re-download (G4/G12) |
| P2 | Remove/Block/Reject on an ended session are still accepted (harmless, documented); sender notice for auto-declined receivers |

## 8. Local run

`docker compose up --build`, then open `https://localhost:8443` in up to six browser profiles: one sends, up to five receive. The sender's dashboard shows every receiver; History lists the result on each device.

## 9. Commits

| Commit | Summary |
|---|---|
| a264916 | Phase 3 closed (QA PASS) |
| 08ab0c7 | Backend: session aggregate, orphan cleanup, lock order |
| d5cacae | Web: History search, filters, detail, delete, retention |
| 06e9211 | Shared block cache, group ETA, Block on TR-6, multi-receiver e2e, nightly five-receivers |
