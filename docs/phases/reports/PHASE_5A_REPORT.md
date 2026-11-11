# Phase 5A report: accounts, device linking, Devices list, cloud history

Status: implemented and tested on the Web; QA rounds 1 (two P0s), 2 (two P1s) and 3 (one P0) failed; every P0/P1 is fixed, QA round 4 pending (`docs/qa/PHASE_5A_QA.md`). File sharing stays guest-first: no Transfer, Receive, onboarding or local History flow signs in. Android and iOS build on these contracts in Phases 6 and 7.

## 1. What was implemented

**Implemented and tested**

- **Backend accounts** (`backend/internal/auth`, migration `0006_accounts.sql`, ADR 0009, ADR 0010).
  - Sign-up, sign-in, sign-out, password reset through a mail adapter (console in development, SMTP/mailpit, in-memory for tests), Argon2id passwords (m=19456 KiB, t=2, p=1).
  - The account session is layered on the calling device's identity: sign-in keeps the device ID, so a running transfer continues. The access token gains `acct` and `dl` from the live session, so revocation takes effect at once.
  - A not-added device gets at most 24 hours. An added device slides for 90 days.
  - Sign-out removes the device from the account, revokes the session and returns a brand-new anonymous identity.
  - `GET /v1/me`, `PATCH /v1/me` (history sync), password change, account device list, rename, revoke, add current device.
  - Rate limits for sign-in, sign-up, reset, password change, pairing and history writes.
- **Keys and history storage** (the server stores opaque blobs only):
  - setup, recovery, device wrapping keys;
  - rotation with pending pickup and `devices_changed` conflicts;
  - chain blobs;
  - one-time pairings;
  - encrypted history entries with a per-user `seq` under an advisory lock, with tombstones.
- **Key authenticity** (ADR 0012, `docs/CLIPBOARD_PROTOCOL.md` §1.13; fixes QA round 1 P0-1).
  - Every ADK version has an Ed25519 key derived from the ADK; the server stores its verify key.
  - A rotation must be signed by the previous version, so a device that knows only the password gets `403 rotation_unauthorized`.
  - A device wrapping key needs a proof signed with the ADK (`403 device_key_unproven` otherwise), so keys are only wrapped to devices that already hold the ADK.
  - Clients verify the chain link and verify key before taking a rotated key, wrap only to proven keys, and check recovery against an anchor derived from the phrase.
  - Proofs must be by the current version and devices re-prove after every new version; rotations wrap exactly the devices proven at the current version and never the device just revoked; a rotation is owed (`rotation_due`) whenever a device with a key leaves the account, and the next ready device performs it; pairing on a device that already holds keys is anchored on those keys (ADR 0014, QA round 2).
  - The recovery public key is signed with ADK(1)'s signing key at setup; a device rotates only after checking that signature with its own ADK(1), so a server cannot substitute a recovery key and receive new ADKs (ADR 0015, QA round 3). History entries must use the current key version.
  - Go, Vitest and e2e tests cover the QA attacks and each rule; shared vectors are in `key_authenticity`.
- **Account session hardening** (ADR 0013).
  - A not-added Web session is bound to the `sa_acct` browser-session cookie (PRD §2) and ends when the browser session does.
  - Retired refresh secrets never re-enter the grace window.
  - `PATCH /v1/me` and `PATCH /v1/devices/{id}` need an added device.
- **Refresh reuse grace** (ADR 0011): the immediately previous refresh secret is accepted once within 30 seconds of its first use, and the newer one is retired. Before this, closing or reloading a page mid-refresh lost the rotated cookie, revoked the device and silently turned the user into a new guest. Account e2e runs had hit this six times. All other reuse still revokes. Tests run against both stores.
- **Web crypto library** (`web/src/lib/crypto`, loaded only on account screens).
  - Account Data Key with HKDF subkeys `clipboard-v1` and `history-v1`, kept as non-extractable AES-GCM keys.
  - Item encryption with AAD `<id>|<version>`; X25519 ECIES wraps for pairing, rotation and recovery; chain blobs.
  - 12-word BIP-39 recovery phrase with Argon2id (64 MiB, t=3) in a Web Worker.
  - IndexedDB key store wrapped by a non-extractable device KEK, wiped on sign-out. Nothing goes in Web Storage.
  - Published vectors in `shared/protocol/schemas/clipboard-vectors.json`, checked against an independent Go implementation (`docs/CLIPBOARD_PROTOCOL.md` §1).
  - WebKit fallbacks: a stored X25519 CryptoKey that reads back as `undefined` falls back to the JS backend; keys rejected by WebCrypto (first byte zero) are regenerated.
- **Web account UI** (`web/src/features/account`, `web/src/pages/account`; `accounts` flag on, `clipboard` flag off).
  - AC-1 `/signin`, AC-2 `/signup` (strength meter, minimum 10 characters), AC-3 `/reset` (request, sent, and `?token=` new password), all with a validated same-origin `returnTo`.
  - AC-4 `/signin/choices`: device name, Add this device (on), Copy this device's history (off, only when adding).
  - AC-5 `/account/key/setup`: the phrase is shown once, with a confirmation and a warning that losing every device and the phrase makes history unrecoverable.
  - AC-6 `/account/key/pair`: QR, copyable `sa1…` code, countdown and New code. The existing device pastes the code from Devices (camera via `BarcodeDetector` where available). Recovery-phrase entry has word suggestions and validation.
  - AC-7 sign-out dialog (keep or clear local history); AC-8 checklist without Clipboard items.
  - Header identity chip.
  - ST-1 Settings: account header, history sync toggle, change password, Manage devices, Sign out; Cloud stays disabled.
  - DV-1 Devices account list (current marked, rename, Revoke with DV-2 confirmation and key rotation, Pair a new device, Add this device).
  - HI-1 History banners and sync status.
  - Device client: it refreshes and retries only on `device_token_invalid` and `device_token_expired`, so a wrong password is never resubmitted. It accepts new tokens after sign-in, add and sign-out.
- **History sync** (`web/src/features/account/sync`).
  - Entries are encrypted with the history subkey under a deterministic entry ID (idempotent) and pulled with a `seq` cursor; entries written under older key versions are read through the chain.
  - Delete and Clear all are sent as tombstones and queued offline. "Copy this device's history" imports once.
  - Cursor and bookkeeping live in IndexedDB.
  - When the account session ends elsewhere, keys and sync data are wiped.

**Implemented but untested**

- Camera QR scanning (`BarcodeDetector`): no Playwright project has a camera. The pasted code exercises the same server flow.
- The offline delete queue in a real browser (Vitest only), the cross-tab sign-in/out broadcast, and renaming another device from the UI (the endpoint is tested in Go).
- Mail delivery over real SMTP (mailpit profile only locally; CI uses the in-memory sink).

**Partially implemented**

- Cloud transfer in Settings stays disabled until Phase 8, as planned.

**Planned**

- Clipboard Sync (5B). Android and iOS account UIs (Phases 6 and 7).

## 2. Usable screens and routes (Web)

Guest: everything from Phases 1–4 unchanged, plus Sign in and Create account entry points in the header, Settings, Devices and History. Signed in: `/signin`, `/signup`, `/reset`, `/signin/choices`, `/account/key/setup`, `/account/key/pair`, `/account/checklist`, Settings account sections, Devices account list, History sync. Android and iOS: not in this phase.

## 3. End-to-end workflows executed

Playwright `web/e2e/account/` (19 tests) in chromium-desktop, firefox-desktop, webkit-desktop, android-chrome and ios-safari, locally and in CI:

- guest transfer, then sign-in from Settings during a second, paced transfer that completes;
- choices both ways;
- Devices account list;
- a second context pairs by pasted code and becomes ready; refused codes;
- recovery phrase;
- revoke with key rotation;
- history sync from context A to B;
- local history import;
- sign-out keep and clear (new device ID);
- password reset through the test mail hook;
- Welcome → Transfer home without a sign-in screen;
- a password-only attacker cannot rotate keys or register an unproven device key;
- a former device with an old key version cannot re-register, and the owed rotation after a sign-out leaves it out;
- a not-added session ends without its browser-session cookie.

Guest suites (`pairing`, `transfer`, `history`, `keep-awake`, `guest`) still pass; no Transfer test signs in.

## 4. Commands and results

Latest local run (CI runs and the phase's CI history are listed at the top of `docs/qa/PHASE_5A_QA.md`):

- `pnpm -C web format:check`, `lint`, `exec tsc -b`: clean. `pnpm -C web test --run`: 47 files, 354 tests passed.
- `pnpm -C web build`: main JS 114,781 bytes gzip (budget 122,880).
- `pnpm protocol:check`, `i18n:check`, `tokens:check`, `lint:md`: pass.
- `go test ./...` with `TEST_DATABASE_URL` (PostgreSQL 16, go1.27.4): pass. `golangci-lint run ./...`: 0 issues. `govulncheck`: nothing reachable.
- Playwright account suite: 19 passed in each of the five projects (`--retries=0`). Guest suites on chromium-desktop: 45 passed, 1 skipped (WebKit-only private-window test).
- CI: run links and the phase's CI history (including the gitleaks failures on a598989 and 96575ba and the Go advisory on e3289ba) are in `docs/qa/PHASE_5A_QA.md`.

## 5. Environment variables and external services

New: `SA_MAIL_SINK` (`console`, `smtp`, `memory`), `SA_SMTP_ADDR`, `SA_SMTP_USERNAME`, `SA_SMTP_PASSWORD`, `SA_MAIL_FROM`; reset links use the existing `SA_PUBLIC_URL`; `VITE_FLAG_ACCOUNTS` (default on; `false` hides account entry points). See `.env.example`. Optional mailpit service (`docker compose --profile mail`). No third-party credentials are needed.

## 6. Known limitations and untested behaviors

- Everything in "Implemented but untested" above.
- The account revocation check and rate limits are per backend instance (multi-instance needs shared state, `docs/SECURITY_MODEL.md` §5).
- Pairing is not anchored on a device that holds no account key yet: a dishonest server could hand such a device a fabricated account key (`docs/CLIPBOARD_PROTOCOL.md` §1.13). Devices that hold keys, rotation pickup and recovery are verified.
- In-origin script (XSS) can read raw account key bytes while it runs; non-extractable storage protects only the KEK, subkeys and the device private key.
- A device whose proof is older than the current version when a rotation happens is left out and must pair again.
- Accounts whose keys were set up before migration 0007 are "legacy" (pre-release data only) and must be recreated.
- The refresh grace window lets a thief who uses a copied secret within 30 seconds of the legitimate refresh hold a session until the legitimate device's next refresh revokes it (ADR 0011).
- Losing every added device and the recovery phrase makes synced history unrecoverable, by design.
- Mobile visual baselines changed (header Sign in chip) and are regenerated on the CI runner.

## 7. Backlog

- P0: none known.
- P1: Clipboard Sync (5B).
- P2: shared revocation and rate-limit state for multiple instances; real SMTP check in staging; camera QR test on a device.

## 8. Local run

```bash
cp .env.example .env
docker compose up -d --build
```

Open <http://localhost:8080>. For password reset mail locally, start mailpit with `docker compose --profile mail up -d` and set `SA_MAIL_SINK=smtp`.

## 9. Commits

On `claude/practical-lovelace-avlb5g`:

- a598989: crypto library
- 96575ba: backend accounts
- 734d716: gitleaks allowlist
- ef0e87f: refresh reuse grace
- e3289ba: Web account UI
- 9874e3f: mobile snapshot baselines
- 5fdffe0: go1.27.4
- 3987ac8: e2e first-block wait
- 4446bee: QA round 1 fixes (key authenticity, session hardening)
- f585651: QA round 2 fixes (current-version proofs, owed rotation, anchored pairing)
- the QA round 3 fix commit that follows them (authenticated recovery key)
