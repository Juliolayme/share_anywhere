# Phase 5 — Clipboard Sync v1 (protocol, crypto, Web client)

Read: PRD §5.9, §7, §11 (clipboard), §13 (Clipboard); `docs/TESTING_AND_CI.md` §3.

Android clipboard UI is built in Phase 6 on top of this protocol; the crypto and protocol are finalized here so Android implements against a frozen contract.

## Scope
- Migrations: `clipboard_events`, `clipboard_device_cursors`, `clipboard_settings`, `clipboard_keys` (wrapped ACK per device, recovery-wrapped copy, key_version).
- Backend `internal/clipboard`: endpoints per PRD §7.4; per-user advisory lock for `seq`; idempotent insert on `event_id`; retention sweeper (7 days, cap 100); payload limit 256 KB; WS metadata events.
- Key management (PRD §7.5) in `web/src/lib/crypto/`: ACK generation, AES-256-GCM encrypt/decrypt with AAD, non-extractable WebCrypto key persistence in IndexedDB, QR pairing flow (new device shows QR, existing device scans with camera **or** pastes the pairing code; Web camera scanning via `BarcodeDetector` where available with manual-code fallback), 12-word recovery phrase (BIP-39 wordlist, Argon2id via WASM), key rotation on device revoke.
- Web clipboard feature: history, manual Sync button, capture status panel driven by capability detection (secure context, API presence, permission state via `navigator.permissions.query({name:'clipboard-read'})` where supported), automatic capture toggle (focus/visibility opportunistic reads, never polling), in-page `copy` event capture, item detail, Copy action, search/filter, clear history, pause sync, sensitive-heuristic skip with disclaimer, offline queue with retry, EN/VI copy.
- Devices page: pairing entry point, revoke triggers rotation.
- `docs/CLIPBOARD_PROTOCOL.md` complete.

## Out of scope
Images/files, Android UI (Phase 6), IME.

## Tests to add
- Backend: 50 parallel inserts → cursor reads never skip/duplicate; idempotent duplicate `event_id` returns the original; payload > 256 KB rejected; retention sweeper; revoked device cannot read new events; a DB dump contains no plaintext marker string inserted by the test.
- Vitest: encrypt/decrypt round-trip, nonce uniqueness over 10k items, AAD tamper detection, recovery phrase derive/unwrap vectors, key rotation keeps old events decryptable.
- Playwright `chromium-desktop`: granted path — manual Sync reads a clipboard value set by the test, event appears on a second context signed in as the same user with a paired key; Copy writes to clipboard; auto-capture toggles. `firefox-desktop`, `webkit-desktop`, `ios-safari`, `android-chrome`: denied/gesture-required path — status panel explains, manual Sync shows actionable fallback, no permission prompt loop (count prompts via page events). Insecure-context test served over plain HTTP asserts the "HTTPS required" state.
- Playwright: new-device pairing by pasted pairing code between two contexts; recovery phrase restore in a fresh context; revoke a device → it cannot decrypt new events.

## CI changes
`e2e-web` adds `clipboard/` spec folder; `security` job adds a grep-based guard failing if `localStorage` is used anywhere under `web/src/lib/crypto`.

## Exit gate
All of the above green; protocol doc frozen with a version tag `clipboard-protocol-v1`; report written.
