# Share Anywhere — Product Requirements

This document is the source of truth for **what** to build. **How and when** is in `docs/phases/`. Standing engineering rules are in `CLAUDE.md`. Sections are numbered so phase files can reference them (for example "PRD §6.4").

---

## 1. Vision

Share Anywhere lets people transfer large files between devices and synchronize text clipboard history across their own devices, without requiring every device to be on the same local network.

Core value:
- Share large files (4–20 GB target) across Android and Web.
- Join a session with QR code, six-digit code, or HTTPS share link.
- Sender explicitly approves every receiver.
- One sender to one receiver, or one sender to up to **five** simultaneous receivers.
- Prefer direct P2P; fall back to TURN relay; optional Cloud Distribution only with explicit consent.
- Resume interrupted transfers without retransmitting verified blocks.
- Clipboard Sync between Android and Share Anywhere Web with a hybrid, permission-aware approach.

The product should feel trustworthy, fast, simple, and technically capable, not like a developer dashboard.

## 2. Explicit product decisions — do not change silently

Decisions marked **(v2)** were open in the first brief and are now fixed.

| Topic | Decision |
|---|---|
| Platforms in scope | Android (native Kotlin) + Web (PC browsers and mobile browsers) |
| iOS **(v2)** | No native app. iOS users use the Web app in Safari. Web receive flow and clipboard manual sync must work on iOS Safari within its limits (see §6.8). Native iOS is backlog, not scope. |
| PC experience | Browser only; no desktop agent |
| Backend | Go modular monolith, PostgreSQL, WebSocket; no microservices or Kubernetes |
| P2P transport | WebRTC DataChannel |
| TURN | coturn, time-limited credentials |
| File size target | 4–20 GB, with honest per-browser limits (§6.8) |
| Receivers | Max 5 per session, enforced atomically server-side |
| Pairing | QR + six-digit code + HTTPS share link |
| Approval | Sender approves each receiver |
| Route selection | Per receiver, decided by the **client**, recorded by the server |
| Route preference | Direct P2P → TURN UDP → TURN TCP/TLS 443 → Cloud (consented) → queue/retry |
| Cloud Distribution | Optional, disabled until consent, budget-capped, client-side encrypted |
| Authentication **(v2)** | Email + password (Argon2id). Web: server-side session + HttpOnly cookie + CSRF token. Android: bearer device token. **No email verification in v1** (structure present, disabled). Password reset via emailed link behind a mail adapter with a dev-mode console/mailpit sink. |
| Guest mode **(v2)** | Guests can **receive** files only, with an ephemeral device identity bound to one session. Sending and clipboard require an account. |
| Clipboard PC | Share Anywhere Web only |
| Clipboard Web strategy | Both: best-effort automatic capture when permitted + always-available manual Sync |
| Clipboard Android | Foreground capture + manual sync action; no background clipboard reading |
| Clipboard payload | Text only, ≤ 256 KB, history cap 100, retention 7 days |
| Clipboard encryption | E2E, AES-256-GCM, server never sees plaintext |
| Clipboard key bootstrap **(v2)** | Account clipboard key generated on the first device. New devices receive the key through **QR pairing** from an existing device (ephemeral X25519 exchange). A **12-word recovery phrase** is shown once at key creation and can unwrap the key. Server stores only wrapped keys and public metadata. |
| Clipboard remote write | User taps Copy; never overwrite the system clipboard automatically |
| Android SDK **(v2)** | minSdk 26, targetSdk 35 |
| Android long transfers **(v2)** | Foreground service type `dataSync`. Android 15 caps `dataSync` at roughly 6 hours per 24 hours; the transfer engine must checkpoint, stop cleanly at the limit, notify the user, and resume on next launch. Evaluate `JobScheduler` user-initiated data transfer jobs (API 34+) as the preferred path in Phase 6. |
| Browser support **(v2)** | See §6.8 matrix. Full large-file receive on Chromium; capability-limited on Firefox and Safari. |
| Styling **(v2)** | Tailwind CSS only on Web; Material 3 + Compose on Android |
| Deployment | Docker Compose, Caddy reverse proxy |

## 3. Brand identity

Direction: **Concept 3 — Universal Transfer**. No logo asset exists in the repository; do not search external sites for one. Create an original logo as part of Phase 0.

Creative guidance:
- a clear two-way transfer/exchange idea;
- a modern rounded symbol suggesting connection across devices and web;
- blue and green primary colors;
- legible at favicon and launcher sizes;
- not literal, not cluttered with device illustrations;
- original; do not imitate a known brand.

Deliverables: primary lockup (symbol + wordmark), standalone symbol, Android adaptive icon layers, Web favicon/app icons, light/dark variants, monochrome variants, SVG sources plus raster exports, and a short brand usage guide (`docs/DESIGN_SYSTEM.md` §Brand). Assets live in `web/public/brand/` and Android `res/` and share one vector source. Add a brand preview page at `/brand` in the Web app (dev builds only).

Palette tokens:
- Primary blue `#0878E8`, primary green `#16C75A`, navy `#102A56`, white `#FFFFFF`
- Light background `#F7FAFD`; dark surfaces deep navy/blue-gray, not pure black
- Accessible semantic tokens for success/warning/error/info

Blue = sending/transfer/navigation, green = receiving/success/connection. Never rely on color alone.

Design principles: modern, minimal, premium, calm, trustworthy; rounded but not childish; strong hierarchy; generous spacing; clear progress visualization; no gradients-heavy, glassmorphism, neon, or decorative blobs; light and dark themes; desktop-first Web that adapts to tablet/phone; Material 3 on Android with Share Anywhere identity; Lucide icons on Web, Material icons on Android; skeletons, empty/success/error/disabled states, confirmation dialogs, toasts/snackbars.

Design-system deliverables before screens: tokens (color, type, spacing, radii, shadows, borders), component inventory, navigation map, breakpoints, form validation patterns, per-screen state model, accessibility rules. Implement tokens in code; no one-off values where tokens exist.

## 4. Information architecture

**Web** main navigation: Transfer, Clipboard, History, Devices, Settings. Account menu: profile, security, sign out. Desktop: sidebar + content. Small screens: compact nav + stacked panels. Public routes: `/join/:token`, `/join` (code entry), `/signin`, `/signup`, `/reset`.

**Android** bottom navigation: Transfer, Clipboard, History, Devices, Settings. System back behavior, permission education, foreground service only for active transfers, lifecycle-safe state.

## 5. Screen inventory

Every screen includes loading, empty, populated, error, offline, and permission-denied states where applicable.

### 5.1 Onboarding and auth
Welcome; Sign in; Create account; Forgot/reset password; Guest receive explanation; Device registration and naming; Clipboard key setup (first device) or pairing (new device) with recovery phrase; Privacy and permissions explanation; First-run checklist.

### 5.2 Transfer home
Two primary actions: **Send files**, **Receive files**. Also: recent sessions, active transfers, connected devices, transfer strategy status, usage/permission guidance. Must not overwhelm new users.

### 5.3 Send flow
1. Select files (Android document picker / Web file picker + drag-and-drop).
2. Review selection (name, type, size, total).
3. Create Share Session.
4. Show QR, six-digit code, HTTPS share link, remaining receiver slots.
5. Waiting for receivers.
6. Receiver request card (device name, platform).
7. Approve / reject.
8. Participant list (max 5).
9. Per-receiver route/connection status.
10. Transfer dashboard.
11. Completed / partially completed / failed / paused / cancelled.
12. Close/expire confirmation.

Rules: approval mandatory; six-digit code is lookup only; links/QR carry capability tokens; expired/revoked/rejected/closed sessions grant nothing; UI never implies access before approval.

### 5.4 Receive flow
1. Scan QR (Android) / 2. Enter code / 3. Open share link (Web join page).
4. Preview sender identity and file list.
5. Request access. 6. Waiting for approval. 7. Approved / rejected / expired.
8. Choose destination (Android SAF / browser save target per §6.8 capability).
9. Receiving progress. 10. Pause/resume/retry. 11. Verification. 12. Completed / failed / partial.
13. Open/share/locate file where the platform allows.

Web join: if the Android app is installed and App Links are verified, open it; otherwise show the Web Join Page. Detect and explain browser capability limits **before** starting the transfer. Never promise background downloads in mobile browsers.

### 5.5 Multi-receiver dashboard
Session ID and status; sender device; each participant and approval state; each file; one transfer card per file–recipient pair; per-recipient progress, speed, ETA, route, retry, error; aggregate progress; pause/resume/remove per receiver; stop all / close session. A slow or disconnected receiver never blocks others.

Session states: `CREATED, WAITING, ACTIVE, COMPLETED, PARTIALLY_COMPLETED, CLOSED, EXPIRED, CANCELLED`.
Transfer states: `PENDING, ACCEPTED, CONNECTING, TRANSFERRING, PAUSED, RESUMING, DISCONNECTED, RECONNECTING, COMPLETED, FAILED, CANCELLED`.
Participant states: `REQUESTED, APPROVED, REJECTED, LEFT, REMOVED`.

### 5.6 History
Past sessions and transfers; search/filter by date, device, status, file name; direction, bytes, source/destination, result; reopen details; delete metadata. Distinguish transferred bytes from file size for partial transfers.

### 5.7 Devices
List account devices (name, platform, last seen, trust state); rename; revoke; mark current device; explain revocation impact. Revocation stops access to future clipboard events and triggers key rotation (§7.5).

### 5.8 Settings
Account/security; theme system/light/dark; language EN/VI; notifications; transfer strategy (Auto default); Cloud Distribution (off until consent); data/battery; clipboard settings; privacy and retention; manage devices; about/version/licenses.

### 5.9 Clipboard screens
**Web:** history; manual Sync action; browser permission/capability status; automatic capture toggle; item detail; Copy; search/filter; clear history confirmation; privacy settings; empty/offline/error.
**Android:** history; foreground capture status; Sync action; notification action entry; item detail and Copy; search/filter; retention; sensitive-item-skipped state; empty/offline/error.
Clipboard UX must always state whether capture is automatic, best-effort, or manual.

## 6. File transfer

### 6.1 Architecture
Go control plane: REST for accounts, devices, sessions, participants, files, transfers; WebSocket for signaling and control events; PostgreSQL for durable metadata; coturn for TURN. Redis is not used in MVP. Clients own the transfer engine (chunking, hashing, flow control, route selection, ETA).

### 6.2 Transfer modes
- **Direct P2P:** one PeerConnection + DataChannel per receiver; sender uploads one stream per receiver.
- **TURN relay:** per-receiver relayed stream; TURN stores nothing and does not reduce sender upload.
- **Cloud Distribution:** optional store-and-forward via S3-compatible storage, consented, cost-estimated, client-side encrypted with a per-file key shared to approved receivers over signaling, TTL and budget enforced, deleted after completion/expiry.
- **P2P cascade:** out of scope.

### 6.3 Route strategy (client-side, per receiver)
Candidate order: Direct P2P → TURN UDP → TURN TCP/TLS 443 → Cloud (if enabled, consented, within budget) → queue/retry. This is a policy, not a claim that the first option is always fastest; compare observed throughput, reliability, constraints, and cost. Use hysteresis and cooldown; switch only on failure or sustained material improvement. The client reports the chosen route to the server for metrics.

### 6.4 Large-file streaming
- Never load whole files into memory; stream with block-based I/O.
- Block size 4 MiB (configurable, benchmarked). Transport frame 64 KiB initially; `bufferedAmountLowThreshold` backpressure; validate real DataChannel message limits per browser pair.
- Bounded buffers and per-peer flow control; per-receiver ACK and retry state.
- SHA-256 per block and whole file. Receiver ACKs a block only after write + verify.
- Receiver persists a completed-block bitmap (IndexedDB on Web, Room/file on Android).
- Resume exchanges the missing-block bitmap, not a last-chunk number; handle out-of-order blocks and holes.
- After route migration: reconnect, authenticate the transfer with its capability, exchange bitmap, send missing blocks.
- Conservative initial concurrency; benchmark on 2 GB-RAM Android devices; do not hard-code by RAM tier.

Block count sanity: 20 GB / 4 MiB = 5120 blocks → 640-byte bitmap.

### 6.5 Metrics and ETA
Measure at clients: candidate pair type, connection state, RTT, effective throughput, loss/retransmit indicators, `bufferedAmount`, ACK rate, verified bytes. Smooth with EWMA. ETA = remaining verified bytes / effective throughput, provisional at first, hidden during disconnect/negotiation; group ETA follows the slowest active receiver. No large pre-transfer speed tests.

### 6.6 Cloud cost and consent
Before Cloud Distribution: show estimated temporary storage, receiver egress, retention, estimated cost or "cost unknown"; require explicit consent; enforce budget cap; on exhaustion pause and offer alternatives. Provider pricing is configuration, never hard-coded facts.

### 6.7 TURN credentials
coturn `use-auth-secret` with HMAC time-limited credentials issued by `backend/internal/turncreds` only to approved participants of an active session, TTL ≤ 1 h, scoped username `expiry:participant_id`.

### 6.8 Browser capability matrix (Web client)

| Capability | Chromium 120+ (desktop, Android) | Firefox 120+ | Safari 17+ (macOS, iOS) |
|---|---|---|---|
| Send large files (`File.slice` streaming) | Yes | Yes | Yes |
| Receive to disk via File System Access API (`showSaveFilePicker`) | Yes | No | No |
| Receive via OPFS + stream download through Service Worker | Yes (fallback) | Yes | Yes, limited by storage quota and background tab suspension on iOS |
| Receive > 2 GB | Yes | Depends on OPFS quota; detect | Usually no on iOS; detect and explain |
| WebRTC DataChannel | Yes | Yes | Yes |
| Clipboard `readText` on user gesture | Yes (permission prompt) | Yes (paste-context prompt) | Yes (paste-context prompt) |
| Clipboard automatic capture on focus | Best-effort | Not reliable | Not reliable |
| Background tab transfer continues | Yes with throttling | Yes | iOS suspends; warn user to keep tab open |

The client runs capability detection before starting and shows the honest outcome. These claims become "tested" only when the matching Playwright project or a real browser run has verified them.

## 7. Clipboard Sync

### 7.1 Product behavior
PC uses Share Anywhere Web only. Web: automatic best-effort capture when permitted + always-available manual Sync. Android: capture while foreground and allowed; manual Sync opens the app and reads only when permitted; no background reading; no Foreground Service workaround; optional IME is out of v1 scope. Received items appear in history; user taps Copy to write to the system clipboard.

### 7.2 Browser constraints
Use `navigator.clipboard.readText()` / `writeText()`; `read()` only for a later image feature. HTTPS required; feature-detect; handle permission denial, missing user activation, insecure context, unsupported browser; call from valid user gestures; no aggressive polling; opportunistic checks on focus/visibility only where policy permits; never spam permission prompts; the page `copy` event captures only in-page copies. Fallback copy: "Click Sync Clipboard to read the current clipboard." Never claim a website can observe clipboard changes from other apps while inactive.

### 7.3 Android constraints
`ClipboardManager` with lifecycle-aware `OnPrimaryClipChangedListener` registered only while an Activity is resumed; unregister on stop; respect sensitive clip flags (`EXTRA_IS_SENSITIVE`); WorkManager for deferrable network sync only; notification action opens an Activity for user-driven sync. Android 10+ restricts background clipboard access; state this in UI.

### 7.4 Protocol and data model
Each capture is an immutable event: `event_id (UUID), user_id, origin_device_id, event_type (TEXT), mime_type, ciphertext, nonce, key_version, payload_size, created_at, expires_at, seq`.

Ordering **(v2 resolution of the sequence-ordering caveat):** `seq` is a per-user monotonically increasing integer assigned inside the insert transaction while holding `pg_advisory_xact_lock(hashtext(user_id))`. This serializes inserts per user so `seq` order equals commit order, and a cursor can safely be `last_seq`. Idempotency on `event_id`. Per-device cursor in `clipboard_device_cursors`. Offline retries must not duplicate events.

REST: `POST /v1/clipboard/events`, `GET /v1/clipboard/events?cursor=`, `GET /v1/clipboard/history`, `DELETE /v1/clipboard/events/{id}`, `DELETE /v1/clipboard/history`, `GET|PUT /v1/clipboard/settings`.
WS: `CLIPBOARD_EVENT_CREATED, CLIPBOARD_EVENT_DELETED, CLIPBOARD_HISTORY_CLEARED, CLIPBOARD_SETTINGS_UPDATED, DEVICE_CONNECTED, DEVICE_DISCONNECTED`. WS carries metadata only; ciphertext is fetched over HTTPS.

### 7.5 Encryption and keys
- Account clipboard key (ACK): 256-bit, generated client-side on first device. Versioned (`key_version`).
- Per item: AES-256-GCM, random 96-bit nonce, AAD = `event_id || key_version`.
- Web: WebCrypto non-extractable `CryptoKey` persisted in IndexedDB; document eviction risk.
- Android: ACK wrapped by an Android Keystore AES key.
- New device pairing: new device shows a QR with an ephemeral X25519 public key and a device-pairing token; the existing signed-in device scans it, derives a shared secret (HKDF), wraps the ACK, and uploads the wrapped blob to the server for one-time pickup. Fallback: the user types the 12-word recovery phrase, which unwraps a server-stored recovery-wrapped copy of the ACK (Argon2id on the phrase).
- Revoking a device bumps `key_version`: a new ACK is generated by the revoking device, wrapped for every remaining device, and old events stay readable with the old version.
- Never put plaintext keys in localStorage, source, analytics, or logs. If all devices and the phrase are lost, old history is unrecoverable; say so in UI.

### 7.6 Safety defaults
Text only; ≤ 256 KB enforced client and server; cap 100 items; 7-day retention; skip platform-flagged sensitive clips; best-effort secret heuristics (OTP-like, token-like) with an honest disclaimer; no plaintext logs; no auto remote write; user can pause sync and clear history.

## 8. Backend domain model

Tables: `users, auth_sessions, devices, share_sessions, session_participants, shared_files, transfers, session_events, capability_tokens, clipboard_events, clipboard_device_cursors, clipboard_settings, clipboard_keys`.

Constraints: atomic max-5 receiver slots per session (`SELECT … FOR UPDATE` on the session row, count active/pending participants, insert); unique `(session_id, device_id)`; participant approved before any file or signaling access; capability token separate from six-digit code, hashed at rest, single-purpose, expiring, revocable; idempotent state transitions; authorization on every resource; no trust in client-supplied identities.

REST surface (final contract in `shared/protocol/openapi.yaml`):
`POST /v1/auth/signup|signin|signout|password-reset`, `GET /v1/me`;
`GET|PATCH|DELETE /v1/devices/{id}`, `POST /v1/devices` ;
`POST /v1/sessions`, `GET /v1/sessions/{id}`, `POST /v1/sessions/{id}/close|renew`, `POST /v1/sessions/join` (code), `POST /v1/sessions/join-link` (token);
`POST /v1/participants/{id}/approve|reject|leave`, `DELETE /v1/participants/{id}`;
`POST|GET /v1/sessions/{id}/files`, `DELETE /v1/files/{id}`, `POST /v1/files/{id}/distribute`;
`GET /v1/transfers/{id}`, `POST /v1/transfers/{id}/pause|resume|cancel`, `GET /v1/sessions/{id}/transfers`;
`POST /v1/turn/credentials`; clipboard endpoints per §7.4.

## 9. Visual design requirements

**Web shell:** brand mark and wordmark, main nav, account/device status, theme selector, responsive sidebar/topbar, page title and primary action.
**Transfer dashboard:** prominent Send/Receive, active transfer summary, session card, device/network indicators, first-run empty state.
**Send session:** drag-and-drop + picker, file list with icon/name/size/remove, total size, create action, QR/code/copy-link panel, live request list, approval controls, capacity indicator.
**Active transfer:** overall, per-receiver, per-file progress; route badge (Direct / Relay / Cloud); throughput and ETA with uncertainty state; pause/resume/retry/cancel; details/error drawer; restrained completion state.
**Receive page:** sender details, file preview, request access, approval wait, destination/permission guidance, progress and verification.
**Clipboard:** Sync button, capture status with capability explanation, item timeline with device and time, truncated preview, Copy, search/filter, clear history, privacy hints.
**History / Devices / Settings:** usable, coherent screens.
**Android:** all equivalent screens in Compose with state hoisting; long-running work out of composables.

Microcopy: "Send files", "Receive files", "Waiting for approval", "Connected directly", "Using relay", "Cloud transfer requires your approval", "Sync Clipboard", "Automatic capture is available when your browser permits it", "Open Share Anywhere to sync clipboard", "Your clipboard content is encrypted before sync". Never "Always syncing".

## 10. Accessibility and localization

Keyboard navigation; screen reader labels and landmarks; focus management in dialogs; no color-only status; touch targets ≥ 48 dp; system font scaling; reduced motion; English and Vietnamese catalogs (`web/src/i18n/{en,vi}.json`, Android `values/`, `values-vi/`); no concatenated fragments; tested breakpoints; QR and code usable on small viewports.

## 11. Security requirements

Auth and authz per `CLAUDE.md` §7 plus: rate-limit sign-in, code lookup, join requests, pairing; IDOR tests for every resource; WebSocket authenticated and origin-checked. Transfer: approval mandatory; validate file metadata server-side; distrust MIME and names; protect signaling; block and file hash verification; prevent unauthorized resume or takeover (resume requires the transfer capability). Clipboard: E2E, no plaintext storage/logging, sensitive flags, no silent remote write, revoke and rotate, retention controls, rate and payload limits. General: input validation, parameterized SQL, CSRF, strict CORS, CSP, no unsafe HTML, log redaction, dependency scanning in CI. Deliver `docs/SECURITY_MODEL.md` with a threat model (assets, trust boundaries, abuse cases, mitigations, residual risks).

## 12. Observability

No file content or clipboard plaintext in telemetry. Metrics: session create/join/approve counts, route outcomes, completion/failure rates, reconnect/resume success, throughput buckets, TURN bytes, cloud consent and estimates, clipboard event counts and sync latency, browser permission failures by family. No third-party analytics without an explicit decision. Prometheus endpoint `/metrics` on the backend; dashboards are post-MVP.

## 13. Acceptance test matrix

Mapped to CI jobs in `docs/TESTING_AND_CI.md`.

**Pairing:** valid QR join; valid code join; expired link; invalid code; rate-limit lockout; approval; rejection; sender closes; sixth receiver rejected atomically under concurrency.
**Transfer:** Web→Web; Android→Web; Web→Android; multiple files; empty/unsupported file; read permission revoked; storage full; sender disconnect; receiver disconnect; pause/resume; out-of-order blocks; missing-block bitmap; checksum mismatch; reconnect and route migration; slow receiver does not stall others; five concurrent receivers; forced TURN relay.
**Clipboard:** Web manual capture; Web auto best-effort; permission denied; insecure/unsupported context; in-page copy event only; no false universal-observation claim; Android foreground capture; Android background restriction; Android manual action; sensitive skipped; duplicate event idempotency; remote item shown; explicit Copy writes; no auto-overwrite; offline queue and reconnect; expiry and deletion; ciphertext undecryptable without client key; new-device pairing; recovery phrase; revoke and rotate.
**UX:** all states; keyboard; screen reader labels; responsive (desktop, Pixel 7, iPhone 14 profiles); dark/light; EN/VI.
