# Phase 5 — Accounts and Clipboard Sync v1 (Web, protocol, crypto)

Read: `CLAUDE.md` §7, §8b; PRD §2 (account-only features, authentication, signing in, signing out, history, account key bootstrap), §5.1b, §5.6–§5.9, §7, §11; `docs/SECURITY_MODEL.md` §4, §5, §7; `docs/ARCHITECTURE.md` §3.3, §8; `docs/API.md` §2.4, §2.5; `docs/UX_SCREEN_MAP.md` §7–§10; §13 (Guest-first, Clipboard); `docs/TESTING_AND_CI.md` §3, §4.

Accounts are introduced here, after the full guest file-sharing experience exists, because only account-only features need them. Run as two milestones, each with its own exit gate and report (`PHASE_5A_REPORT.md`, `PHASE_5B_REPORT.md`). 5B starts when 5A is green. Android (Phase 6) and iOS (Phase 7) build their account and clipboard UIs on the contracts frozen here.

---

## Milestone 5A — Accounts, device linking, Devices list, cloud history

### Scope
- Migrations: `users`, `auth_sessions`, `password_resets`, `account_keys`, `device_pairings`, `history_entries`, plus `devices.kind`/`user_id` transitions.
- `backend/internal/auth`: sign up, sign in, sign out, password reset (mail adapter with console and mailpit sinks), Argon2id; account session layered on the calling device's identity; access token gains `acct` and `dl`; post-sign-in choices (add device, copy history); short account session (24 h) for not-added devices; sign-out removes the device from the account, revokes the account session, and returns a fresh anonymous identity; `GET /v1/devices`, rename, revoke, `POST /v1/devices/current/add`; sign-in, sign-up, and reset rate limits.
- Account Data Key (PRD §7.5) in `web/src/lib/crypto/`: ADK generation at sign-up, HKDF subkeys, non-extractable WebCrypto storage in IndexedDB, 12-word recovery phrase (BIP-39 wordlist, Argon2id via WASM), device pairing by QR (camera via `BarcodeDetector` where available) or pasted pairing code, key rotation on revoke.
- Cloud history sync: encrypted `history_entries` with per-user `seq`, Settings toggle, merge into the local History view, import of local history when the user chose "Copy this device's transfer history".
- Web UI: `/signin`, `/signup`, `/reset` with `returnTo`; header identity chip with Sign in; Settings Guest header gains Sign in and Create account; account sections in Settings (history sync, manage devices; Cloud remains for Phase 8); Devices guest intro with Sign in, account device list, "Add this device"; History banner with Sign in / Turn on history sync; sign-out confirmation with keep/clear local history. Turn on the `accounts` flag.
- Update `docs/SECURITY_MODEL.md` (account takeover, refresh-secret theft, guest-to-account linkability, history encryption), `docs/ARCHITECTURE.md` §3.3 and §8, and `docs/API.md` §2.4 with what was built; keep `openapi.yaml` in agreement.

### Tests to add
- Backend: Argon2id parameters; sign-up/sign-in/sign-out; sign-in keeps the device ID; `dl` false when "add device" is off and account session expires in 24 h; sign-out returns a new device ID and revokes the old account session; every `account` and `account+device` route returns `403 account_required` for guest tokens and `403 device_not_added` for not-added devices (table-driven over the OpenAPI access levels); history `seq` ordering under 50 parallel inserts; revoked device cannot read new history; rate limits for sign-in, sign-up, reset.
- Vitest: ADK generation, HKDF subkeys, recovery phrase vectors, key rotation keeps old entries decryptable. Publish vectors to `shared/protocol/schemas/clipboard-vectors.json` (ADK, subkeys, item encryption).
- Playwright: guest completes a transfer, then signs in from Settings **during a second active transfer** and the transfer continues; post-sign-in choices both ways; Devices shows account list; second context pairs by pasted code; history sync on → entry from context A appears in context B; local history import; sign-out with keep and with clear; Welcome → Transfer home still has no sign-in screen.

### Exit gate (5A)
All tests green in all five projects; no Transfer flow test signs in; report `PHASE_5A_REPORT.md` written.

---

## Milestone 5B — Clipboard Sync

### Scope
- Migrations: `clipboard_events`, `clipboard_device_cursors`, `clipboard_settings`.
- `backend/internal/clipboard`: endpoints per PRD §7.4 at `account+device` level; per-user advisory lock for `seq`; idempotent insert on `event_id`; retention sweeper (7 days, cap 100); payload limit 256 KB; event creation rate limit; WS metadata events to `account+device` sockets only.
- Web Clipboard tab (turn on the `clipboard` flag):
  - Guest: the account-required intro (PRD §5.9) with Sign in / Create account returning to `/clipboard`; **no** clipboard reads, permission queries, or clipboard API calls.
  - Signed in, device not added: "Add this device to use Clipboard Sync".
  - Signed in, device added, ADK missing: pairing / recovery screen.
  - Ready: history, manual Sync button, capture status panel from capability detection (secure context, API presence, `navigator.permissions.query({name:'clipboard-read'})` where supported), automatic capture toggle (focus/visibility opportunistic reads, never polling), in-page `copy` event capture, item detail, Copy, search/filter, clear history, pause sync, sensitive-heuristic skip with disclaimer, offline queue with retry, EN/VI copy.
- `docs/CLIPBOARD_PROTOCOL.md` complete.

### Out of scope
Images/files, Android UI (Phase 6), iOS UI (Phase 7), IME.

### Tests to add
- Backend: 50 parallel inserts → cursor reads never skip/duplicate; idempotent duplicate `event_id`; payload > 256 KB rejected; retention sweeper; revoked device cannot read new events; guest token → `403 account_required` on every clipboard route; a DB dump contains no plaintext marker string inserted by the test.
- Vitest: encrypt/decrypt round-trip, nonce uniqueness over 10k items, AAD tamper detection.
- Playwright: guest opens Clipboard → intro shown, Sign in returns to Clipboard, and the page made zero `navigator.clipboard` calls while a guest (instrumented via `addInitScript`). `chromium-desktop` granted path: manual Sync reads a value set by the test, event appears on a second signed-in context with a paired key; Copy writes to clipboard; auto-capture toggles. `firefox-desktop`, `webkit-desktop`, `ios-safari`, `android-chrome`: denied/gesture-required path, actionable fallback, no permission prompt loop. Insecure-context test over plain HTTP shows "HTTPS required". Revoke a device → it cannot decrypt new events.

### CI changes
`e2e-web` adds `account/` and `clipboard/` spec folders; `security` job adds a grep guard failing if `localStorage` is used under `web/src/lib/crypto` or for tokens.

### Exit gate (5B)
All of the above green; protocol doc frozen with tag `clipboard-protocol-v1`; report `PHASE_5B_REPORT.md` written.
