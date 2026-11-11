# Phase 5B report: Clipboard Sync v1

Status: implemented and tested on the Web; QA round 1 failed on two P1s (missing protocol tag, unspecified UUID text form in the AAD), both fixed; QA round 2 failed on one P1 (a late create ack could delete a synced item), fixed; QA round 3 pending (`docs/qa/PHASE_5B_QA.md`). File sharing stays guest-first. Guests see the Clipboard intro and the app makes no clipboard API calls for them. Android and iOS build their clipboard UIs on this protocol in Phases 6 and 7.

## 1. What was implemented

**Implemented and tested**

- **Backend** (`backend/internal/clipboard`, migration `0010_clipboard.sql`).
  - Immutable encrypted text events with a per-user `seq` assigned under an advisory lock (seq order equals commit order). A `last_seq` counter means a `seq` is never reused after the retention sweep.
  - Writes are idempotent on `event_id`. Delete and Clear history leave tombstones that every device sees through its cursor.
  - History endpoint (newest first) and per-device cursors (`clipboard_device_cursors`, deleted when the device leaves the account).
  - Account settings: pause, retention of 1 to 7 days, sensitive skip.
  - Current key version only (`409 key_version_conflict`). While paused, new events are refused (`409 clipboard_paused`).
  - Limits: 256 KB payload (`413`), at most 100 live items, a retention sweep in the maintenance loop, and rate limits of 60 per minute per device and 240 per minute per account.
  - Every route is `account+device`. Writes re-check the caller's live session after taking the account key row lock, the Phase 5A rule.
  - WebSocket messages carry metadata only: `CLIPBOARD_EVENT_CREATED`, `CLIPBOARD_EVENT_DELETED`, `CLIPBOARD_HISTORY_CLEARED`, `CLIPBOARD_SETTINGS_UPDATED`, `DEVICE_CONNECTED`, `DEVICE_DISCONNECTED`. They go only to the account's added devices with a live session.
- **Protocol** (`docs/CLIPBOARD_PROTOCOL.md` §2, frozen for `clipboard-protocol-v1`).
  - Covers event format, encryption (`clipboard-v1` subkey, AAD `<event_id>|<key_version>`), cursors, idempotency, WebSocket messages, limits, pause, sensitive content, offline queue, Web capture rules, and revocation.
  - OpenAPI has 66 operations and `websocket-events.json` has the six new messages.
- **Web** (`web/src/features/clipboard`; `clipboard` flag on).
  - CB-1 guest intro. Clipboard access cannot happen for guests: `capture.ts` is the only module that touches `navigator.clipboard`, the permission or the `copy` event, and it loads only for a ready account. A Vitest source scan enforces this.
  - CB-2 "Add this device" and CB-3 pairing or recovery screens.
  - CB-4 home:
    - the Sync Clipboard button (`readText` in the click) and a paste fallback;
    - a capture status panel showing `auto`, `besteffort`, `denied`, `unsupported`, `offline`, `paused`, or HTTPS required;
    - an automatic capture toggle that reads on focus or visibility only when permission is already granted, with no polling and no prompts, plus in-page `copy` capture;
    - the sensitive skip with a disclaimer and "Sync anyway";
    - search and filters;
    - the timeline with queued and locked rows;
    - Clear history.
  - CB-5 item detail with Copy (with fallbacks) and Delete.
  - CB-6 settings at `/settings/clipboard`, plus a Clipboard section in Settings.
  - Offline queue in IndexedDB, retried by `event_id`, with re-encryption after a key change.
  - Cursor sync driven by WebSocket messages, reconnects and focus.
  - Sign-out or session end wipes the clipboard store.
  - The AC-8 checklist offers "Go to Clipboard".
- **CI**: the `security` job runs `pnpm storage:check`. It fails on Web Storage or cookies in key or clipboard code, and on Web Storage keys named after secrets. Node tests cover it.
- **Tests**:
  - Go: 50 parallel inserts against the cursor, idempotency, `413`, the 100-item cap and the sweep, pause, key version, departed devices, the access table, no plaintext at rest, WebSocket fan-out with real sockets, and rate limits.
  - Vitest: encrypt and decrypt round trip, 10,000 unique nonces, AAD tampering, the sensitive heuristics, the offline queue, status derivation, and the guest path making no clipboard calls.
  - Playwright `web/e2e/clipboard/`, in the browser projects listed in §3.

**Implemented but untested**

- Real permission prompts and the system Paste UI in Firefox and Safari. Playwright cannot click them, so the tests stub `readText` to refuse. Capability detection itself is real.
- Automatic capture on real mobile browsers, and the system clipboard across apps on a real device.

**Partially implemented**

- Retention options are 7, 3 and 1 days, each capped at 100 items. The design's 50-item and "Until I clear" options are not offered (DESIGN_DEVIATIONS A6).

**Planned**

- The Android and iOS clipboard UIs (Phases 6 and 7). Images and files (out of v1 scope).

## 2. Usable screens and routes (Web)

Everything from Phases 1–5A is unchanged, plus:

- `/clipboard` (CB-1 to CB-4);
- `/clipboard/:eventId` (CB-5);
- `/settings/clipboard` (CB-6);
- a Clipboard tab in the navigation, between Transfer and History.

## 3. End-to-end workflows executed

Playwright `web/e2e/clipboard` (guest, granted, denied, insecure, revoke) together with `web/e2e/account`:

- **Guest:** the intro, with zero `navigator.clipboard` calls (instrumented). Sign in returns to Clipboard.
- **Granted path (chromium-desktop):** manual Sync reads a value set by the test, and the event appears on a second paired context. Copy writes to the clipboard, and automatic capture can be toggled.
- **Denied or gesture-required path (other projects):** an actionable fallback with no prompt loop.
- **Insecure context:** plain HTTP on a non-localhost host shows "HTTPS required" (chromium-desktop).
- **Revoke:** a revoked device cannot decrypt new events.

Exact counts per project and CI links are in §4 and `docs/qa/PHASE_5B_QA.md`.

## 4. Commands and results

Latest local run (CI runs are listed at the top of `docs/qa/PHASE_5B_QA.md`):

- `pnpm -C web format:check`, `lint`, `exec tsc -b`: clean. `pnpm -C web test --run`: 55 files, 442 tests passed.
- `pnpm -C web build`: main JS 117,266 bytes gzip (budget 122,880).
- `pnpm protocol:check` (66 operations), `i18n:check` (2001 keys each), `tokens:check`, `lint:md`, `storage:check`, `test:scripts`: pass.
- `go test ./...` with `TEST_DATABASE_URL` (PostgreSQL 16, go1.27.4): pass. `golangci-lint run ./...`: 0 issues. `govulncheck`: nothing reachable.
- Playwright `e2e/clipboard` + `e2e/account` (`--retries=0`): chromium-desktop 24 passed, 1 skipped; firefox-desktop, webkit-desktop, android-chrome and ios-safari 23 passed, 2 skipped each.
  - The skips are documented: the granted path needs Chromium's clipboard permission grant; the denied path runs everywhere except chromium-desktop, which runs the granted path; the insecure-context test needs Chromium's host resolver rules.
- Guest suites (`pairing`, `transfer`, `history`, `keep-awake`, `guest`) on chromium-desktop: 45 passed, 1 skipped (the WebKit-only private-window test).

## 5. Environment variables and external services

`VITE_FLAG_CLIPBOARD` defaults to on; set it to `false` to build without the Clipboard tab (it also needs `VITE_FLAG_ACCOUNTS`). Clipboard rate limits have defaults in configuration, overridable for tests. No external services are needed.

## 6. Known limitations and untested behaviors

- Everything in "Implemented but untested" above.
- A website cannot see clipboard changes made in other apps while it is not active. The UI says capture is automatic only on focus, best-effort, or manual.
- `GET /v1/clipboard/events?limit=200` can return up to about 25 MB of ciphertext when every live item is close to 256 KB. The 100-item cap bounds it.
- A revoked device that kept its ADK versions can still decrypt events encrypted under those versions (created before the rotation), the same as history (`docs/SECURITY_MODEL.md` §7, former device row); events after the rotation use a key it never receives.

## 7. Backlog

- P0: none known.
- P1: Android (Phase 6) and iOS (Phase 7) clipboard UIs.
- P2:
  - a page byte cap on `GET /v1/clipboard/events`;
  - the remaining retention options;
  - a real-device check of the permission prompts.

## 8. Local run

```bash
cp .env.example .env
docker compose up -d --build
```

Open <http://localhost:8080>, sign in, add the device, set up the key, then open Clipboard. Clipboard reads need HTTPS or `localhost`.

## 9. Commits

On `claude/practical-lovelace-avlb5g`:

- 063de1d: CI storage guard
- b956f0f: clipboard backend
- fab4866: Web Clipboard
- de39866: mobile snapshot baselines (fifth tab)
- 8d2cb0e: QA round 1 backend fixes (canonical ids, sweep, size check, read limit)
- 726c0a2: QA round 1 Web fixes (canonical ids, ghost after delete, honest capture states)
- the QA round 2 fix commit that follows them

The annotated tag `clipboard-protocol-v1` is created at the commit that passes QA (the exit gate in `docs/phases/PHASE_5_ACCOUNTS_CLIPBOARD.md`) and pushed with it.
