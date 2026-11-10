# Share Anywhere — Product Requirements

This document is the source of truth for **what** to build and the product decisions behind it. **How and when** is in `docs/phases/`. Standing engineering rules are in `CLAUDE.md`. Details that used to live here now have their own files, and this document points to them instead of repeating them:

| Topic | File |
|---|---|
| Components, flows, server data model, client storage, keep-screen-on lifecycle | `docs/ARCHITECTURE.md` |
| Every screen, destinations, Guest vs Signed in variants | `docs/UX_SCREEN_MAP.md` |
| Join modes, tokens, lifetimes, rate limits, threat model, privacy | `docs/SECURITY_MODEL.md` |
| Endpoints, access levels, errors, WebSocket events | `docs/API.md` |
 Sections are numbered so phase files can reference them (for example "PRD §6.4").

---

## 1. Vision

Share Anywhere lets people transfer large files between devices and synchronize text clipboard history across their own devices, without requiring every device to be on the same local network.

Core value:
- **Guest-first file sharing:** open the app or the website and send or receive immediately. No account, no sign-in wall.
- Share large files (4–20 GB target) across Android, iOS, and Web.
- Join a session with QR code, six-digit code, or HTTPS share link.
- **Open join by default:** whoever enters the right code or opens the link/QR starts receiving right away. The sender can turn on **Require approval** per session and can always Remove or Block a receiver.
- One sender to one receiver, or one sender to up to **five** simultaneous receivers.
- Prefer direct P2P; fall back to TURN relay; optional Cloud Distribution only with explicit consent.
- Resume interrupted transfers without retransmitting verified blocks.
- Clipboard Sync between Android, iOS, and Share Anywhere Web with a hybrid, permission-aware approach. This is the **only** core feature that requires an account, together with the account-wide Devices list and cloud-synced history.

The product should feel trustworthy, fast, simple, and technically capable, not like a developer dashboard.

## 2. Explicit product decisions — do not change silently

Decisions marked **(v2)** were open in the first brief and are now fixed. Decisions marked **(v3)** were added or changed later; the guest-first identity model is a v3 change and supersedes the earlier "guests receive-only" rule. Decisions marked **(v4)** are the latest: open join by default (supersedes "sender approves each receiver") and keeping the screen on during transfers.

| Topic | Decision |
|---|---|
| Platforms in scope **(v3)** | Android (native Kotlin) + iOS (native Swift/SwiftUI) + Web (PC browsers and mobile browsers) |
| iOS **(v3)** | Native SwiftUI app, iOS 16+, built in Phase 7 against the protocol frozen in Phases 3 and 5. The Web receive flow and clipboard manual sync must still work on iOS Safari (see §6.8) for people without the app. |
| PC experience | Browser only; no desktop agent |
| Backend | Go modular monolith, PostgreSQL, WebSocket; no microservices or Kubernetes |
| P2P transport | WebRTC DataChannel |
| TURN | coturn, time-limited credentials |
| File size target | 4–20 GB, with honest per-browser limits (§6.8) |
| Receivers | Max 5 per session, enforced atomically server-side |
| Pairing | QR + six-digit code + HTTPS share link |
| Join and approval **(v4)** | **Open join is the default:** a valid six-digit code, link, or QR admits the receiver immediately, up to 5 receivers. **Require approval** is an optional per-session setting, **default off**, that the sender can switch at any time (future joins only). The sender can always **Remove** or **Block** a receiver and **Stop accepting**. Because an open-join code admits people, it is protected as a short-lived secret: 5-minute rotation, dies when the session is full or not accepting, per-IP and per-device lockouts, and a global **protected mode** that forces approval for code joins when guessing spikes. Both sides see verification words. Details in `docs/SECURITY_MODEL.md` §3. |
| Keep screen on **(v4)** | While sending, receiving, or waiting for receivers, the app keeps the screen on: iOS `isIdleTimerDisabled`, Web Screen Wake Lock API (re-requested when the tab becomes visible again, with a fallback reminder when unsupported or refused), Android `FLAG_KEEP_SCREEN_ON` while a transfer screen is visible (the foreground service still carries the transfer when the screen is off). It turns off automatically when transfers finish, pause, or are cancelled, or the session ends. Setting **Keep screen on during transfers**, default on. Every transfer screen shows the current status. Details in `docs/ARCHITECTURE.md` §7. |
| Route selection | Per receiver, decided by the **client**, recorded by the server |
| Route preference | Direct P2P → TURN UDP → TURN TCP/TLS 443 → Cloud (consented) → queue/retry |
| Cloud Distribution **(v3)** | Optional, disabled until consent, budget-capped, client-side encrypted. **The sender must be signed in** to use it (cost attribution, budget cap, storage-abuse control, retention). Guest receivers may download cloud-distributed files from a session they joined. Guests see the Cloud option disabled with "Sign in to use Cloud transfer". |
| Guest-first file sharing **(v3)** | Sending and receiving files **never require an account** on Web, Android, or iOS. First launch shows a single Welcome screen whose only action leads straight to Transfer home. No sign-in screen sits in front of any transfer flow. Adding an account requirement to any Transfer flow is a product-decision change and needs an ADR. |
| Account-only features **(v3)** | Exactly these require Sign in / Create account: Clipboard Sync, the account-wide Devices list (other devices, revoke, pairing), cloud-synced transfer history, and Cloud Distribution as a sender. Everything else works as a guest. |
| Device identity **(v3)** | Every installation or browser profile gets an **anonymous device identity** on first launch: a server-issued device ID, a short-lived signed **device access token** (JWT, EdDSA/Ed25519, 15 min TTL, strict algorithm allowlist, `kid` for key rotation), and a long-lived **device refresh secret** (256-bit, hashed at rest, rotated on every use, reuse detection revokes the device). Anonymous identities expire after 30 days without use. Details in `docs/SECURITY_MODEL.md` §4 and `docs/ARCHITECTURE.md` §3. |
| Authentication **(v3)** | Email + password (Argon2id) for accounts. An account session is **layered on top of** the device identity: after sign-in the device access token carries an `acct` claim. All API calls use the bearer access token; the Web keeps the refresh secret in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to the refresh endpoint and holds the access token in memory only. Native apps keep the refresh secret in Android Keystore-backed storage or the iOS Keychain. **No email verification in v1** (structure present, disabled). Password reset via emailed link behind a mail adapter with a dev-mode console/mailpit sink. |
| Signing in on a device **(v3)** | Sign-in never interrupts an active transfer (the device ID does not change). After sign-in the user chooses: **"Add this device to your account"** (default on; required for Clipboard Sync on this device and for it to appear as trusted in Devices) and **"Copy this device's transfer history to your account"** (default off; shown only when the device is added). A signed-in but not-added device gets a short account session (24 h max, browser-session cookie on Web) and sees "Add this device to use Clipboard Sync". |
| Signing out **(v3)** | Removes the device from the account, deletes local account key material, revokes the account session, and issues a **fresh anonymous identity** (new device ID) so guest activity after sign-out cannot be linked to the account. Local history is kept or cleared at the user's choice. |
| History **(v3)** | Always stored **locally** on the device (IndexedDB on Web, Room on Android, Core Data or GRDB on iOS; iOS 16 rules out SwiftData). Signed-in users can turn on **cloud history sync**, which uploads end-to-end encrypted entries (§7.5). The server's own session records are operational, not history, and are purged 7 days after a session ends. |
| Abuse controls for anonymous use **(v3, extended v4)** | Rate limits keyed by IP (IPv6 by /64) **and** by device for device creation, session creation, code lookup and failed lookups, joins, TURN credentials, and WebSocket connections; proof-of-work on anonymous device creation above a soft limit; protected mode; Remove and Block (device ID and IP /64); strict session lifetimes. Values in `docs/SECURITY_MODEL.md` §5 and §6. |
| Clipboard PC | Share Anywhere Web only |
| Clipboard Web strategy | Both: best-effort automatic capture when permitted + always-available manual Sync |
| Clipboard Android | Foreground capture + manual sync action; no background clipboard reading |
| Clipboard iOS **(v3)** | Foreground capture on `UIPasteboard.changeCount` change while active; manual sync via `UIPasteControl` (no system paste prompt) with a plain button fallback that accepts the iOS 16+ paste banner; no background reading; `detectPatterns` used to skip likely secrets without reading content first |
| Clipboard payload | Text only, ≤ 256 KB, history cap 100, retention 7 days |
| Clipboard encryption | E2E, AES-256-GCM, server never sees plaintext |
| Account key bootstrap **(v2, renamed v3)** | An **Account Data Key (ADK)** is generated on the first device at account creation. It derives separate subkeys for clipboard and cloud history (HKDF labels `clipboard-v1`, `history-v1`). New devices receive the ADK through **QR pairing** from an existing device (ephemeral X25519 exchange). A **12-word recovery phrase** is shown once at key creation and can unwrap the ADK. Server stores only wrapped keys and public metadata. |
| Clipboard remote write | User taps Copy; never overwrite the system clipboard automatically |
| Android SDK **(v2)** | minSdk 26, targetSdk 35 |
| iOS long transfers **(v3)** | iOS suspends apps roughly 30 s after backgrounding; WebRTC and sockets do not survive. Transfers run only while the app is foreground or in the short `beginBackgroundTask` window; the engine checkpoints the bitmap, shows a local notification "Return to Share Anywhere to continue", and resumes on foreground. `BGProcessingTask` is used only for deferrable clipboard sync and cleanup, never for transfers. Do not use audio/VoIP/location background modes as workarounds (App Review rejection). Cloud Distribution (Phase 8) is the recommended path for very large iOS transfers and the UI should say so; because Cloud requires a signed-in sender, a guest iOS sender sees "Sign in to let large transfers finish in the background". |
| Android long transfers **(v2)** | Foreground service type `dataSync`. Android 15 caps `dataSync` at roughly 6 hours per 24 hours; the transfer engine must checkpoint, stop cleanly at the limit, notify the user, and resume on next launch. Evaluate `JobScheduler` user-initiated data transfer jobs (API 34+) as the preferred path in Phase 6. |
| Browser support **(v2)** | See §6.8 matrix. Full large-file receive on Chromium; capability-limited on Firefox and Safari. |
| iOS storage and files **(v3)** | Received files are written with streaming `FileHandle` into the app's Documents directory exposed through the Files app (`UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`); users may also pick a destination folder with `UIDocumentPickerViewController` (security-scoped bookmarks persisted for resume). Sending uses `UIDocumentPickerViewController` with `asCopy: false` and security-scoped access. |
| Universal Links **(v3)** | `/join/:token` opens the iOS app when installed via `apple-app-site-association` served by Caddy; Android App Links via `assetlinks.json`. Verified only on real devices; CI marks as untested. |
| Styling **(v2)** | Tailwind CSS only on Web; Material 3 + Compose on Android; SwiftUI with a shared token file (`shared/design/tokens.json` → generated Swift, Kotlin, CSS) on iOS |
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

Deliverables: primary lockup (symbol + wordmark), standalone symbol, Android adaptive icon layers, iOS `AppIcon.appiconset` (1024 px source, light/dark/tinted variants for iOS 18), Web favicon/app icons, light/dark variants, monochrome variants, SVG sources plus raster exports, and a short brand usage guide (`docs/DESIGN_SYSTEM.md` §Brand). Assets live in `web/public/brand/`, Android `res/`, and `ios/ShareAnywhere/Assets.xcassets`, and share one vector source. Add a brand preview page at `/brand` in the Web app (dev builds only).

Palette tokens:
- Primary blue `#0878E8`, primary green `#16C75A`, navy `#102A56`, white `#FFFFFF`
- Light background `#F7FAFD`; dark surfaces deep navy/blue-gray, not pure black
- Accessible semantic tokens for success/warning/error/info

Blue = sending/transfer/navigation, green = receiving/success/connection. Never rely on color alone.

Design principles: modern, minimal, premium, calm, trustworthy; rounded but not childish; strong hierarchy; generous spacing; clear progress visualization; no gradients-heavy, glassmorphism, neon, or decorative blobs; light and dark themes; desktop-first Web that adapts to tablet/phone; Material 3 on Android with Share Anywhere identity; Lucide icons on Web, Material icons on Android; skeletons, empty/success/error/disabled states, confirmation dialogs, toasts/snackbars.

Design-system deliverables before screens: tokens (color, type, spacing, radii, shadows, borders), component inventory, navigation map, breakpoints, form validation patterns, per-screen state model, accessibility rules. Implement tokens in code; no one-off values where tokens exist.

## 4. Information architecture

All three clients open on **Transfer home** for guests and signed-in users alike. Navigation is the same for both: **Transfer, Clipboard, History, Devices, Settings**. Account-only content appears inside those tabs, never as a gate in front of the app. Web uses a sidebar on desktop and a compact bar on small screens; Android uses bottom navigation; iOS uses a `TabView` with a `NavigationStack` per tab. Welcome is shown once on first launch and leads only to Transfer home. Account screens are reached only from account CTAs and return the user to where they started.

Every screen, its destination, entry points, and what guests and signed-in users see are listed in `docs/UX_SCREEN_MAP.md`.

## 5. Screen behavior rules

Every screen includes loading, empty, populated, error, offline, and permission-denied states where applicable. Screen-by-screen content is in `docs/UX_SCREEN_MAP.md`; these are the rules the screens must follow.

### 5.1 Onboarding (guest-first)
- Welcome is a single screen with one primary action, **Get started**, which opens Transfer home. An optional "Already have an account? Sign in" link is allowed but never required.
- The anonymous device identity is created silently in the background. If creation fails, Transfer home still opens with an inline retry; local features keep working.
- The device display name is auto-generated (platform model + two random words) and editable later. It is shown to the other side when joining.
- Permissions are requested just in time: camera when scanning a QR code, notifications when a transfer starts. Local network access is never requested.
- No blocking first-run checklist.

### 5.1b Account screens
Sign in, Create account, Reset password, the after-sign-in choices ("Add this device to your account" on, "Copy this device's transfer history" off), Account Data Key setup with recovery phrase, device pairing or recovery phrase entry, and Sign out with keep/clear local history. Entry points are listed in `docs/UX_SCREEN_MAP.md` §9.

### 5.2 Transfer home
Send files and Receive files are the two primary actions, identical for guests and signed-in users. Show active transfers, recent transfers from local history, transfer strategy status, and guidance without overwhelming new users.

### 5.3 Send
- Works without an account.
- Creating a session produces a QR code, a six-digit code with its rotation countdown, and an HTTPS share link, plus the remaining receiver slots.
- **Require approval** is visible on the review screen and in the session, default off. The review screen hints to turn it on for sensitive files.
- With open join, receivers appear in the participant list as they join, each with display name, platform, Guest/Signed in badge, and verification words, and the sender gets a toast (or a local notification when the app is in the background). Remove and Block are always one tap away. After the first join the sender is nudged: "Everyone here? Stop accepting new receivers".
- With approval on, joiners appear as request cards with Approve, Reject, and Block.
- When protected mode applies, the sender sees why code joins need approval.
- The Cloud option is visible but disabled for guests with "Sign in to use Cloud transfer".
- The keep-screen-on status row is visible while waiting for receivers and during transfers.

### 5.4 Receive
- Works without an account. Entry by QR scan (native), six-digit code, or link. A first-time visitor arriving by link skips Welcome.
- The join preview shows the sender's display name and badge and the file names, sizes, and count, nothing more.
- Tapping **Receive** joins the session. With open join the transfer starts right away (on Web after the save target is chosen). With approval on, or in protected mode for code joins, the receiver waits for the sender and sees the same verification words.
- Outcomes include removed, blocked, rejected, expired, session full, and session not accepting, each with a clear message.
- Browser capability limits are detected and explained before the transfer starts. Never promise background downloads in mobile browsers.
- If the Android or iOS app is installed and App Links / Universal Links are verified, the link opens the app; otherwise the Web join page.
- The keep-screen-on status row is visible while waiting and receiving; iOS adds "Locking your iPhone pauses the transfer".

### 5.5 Multi-receiver dashboard
One transfer card per file–receiver pair with progress, speed, ETA, route, retry, and error; aggregate progress; pause, resume, Remove, and Block per receiver; stop all; close session. A slow or disconnected receiver never blocks others. State machines are in `docs/ARCHITECTURE.md` §4.5.

### 5.6 History
Local on the device for everyone; optional encrypted cloud sync for signed-in users. Search and filter by date, peer device, status, file name; distinguish transferred bytes from file size for partial transfers; delete entries; clear all.

### 5.7 Devices
Guests see only "This device" (rename, reset identity) and an account-required intro. Signed-in users with the device added manage all account devices; revoking a device stops its access to future clipboard and history events and rotates the Account Data Key (§7.5).

### 5.8 Settings
Guests see a "Guest" header with Sign in and Create account. Available to everyone: device name, theme, language, notifications, transfer strategy (Auto), **Keep screen on during transfers** (default on), data and battery, local history retention and clear, privacy, about. Cloud Distribution, history sync, clipboard settings, and device management are account-only and shown disabled with a Sign in action for guests.

### 5.9 Clipboard
- Guests see an informational intro (what it does, end-to-end encrypted, needs an account) with Sign in and Create account. **No** clipboard reads, permission prompts, or clipboard API calls happen for guests.
- Signed in but device not added: "Add this device to use Clipboard Sync". Device added without the key: pairing or recovery phrase first.
- When ready: history, Sync Clipboard (Web button, Android action, iOS `UIPasteControl` with a fallback button), capture status, item detail with Copy, search, clear history. UX always states whether capture is automatic, best-effort, or manual.

### 5.10 Keep screen on
- Applies to sending, receiving, and waiting for receivers or for approval; released when transfers complete, fail, pause, or are cancelled, when the session ends, or when the receiver leaves or is removed.
- Controlled by **Keep screen on during transfers** (default on, stored per device).
- Every transfer screen shows one status: on, off by setting, not supported (Web), or refused (Web), with platform hints. Mechanics per platform are in `docs/ARCHITECTURE.md` §7.
- On Web, when the API is missing or refused, show "Keep this tab open and visible" instead of using hidden-video workarounds.

## 6. File transfer

### 6.1 Architecture
Go control plane: REST for device identity, accounts, sessions, participants, files, transfers; WebSocket for signaling and control events; PostgreSQL for durable metadata; coturn for TURN. Redis is not used in MVP. Clients own the transfer engine (chunking, hashing, flow control, route selection, ETA).

### 6.2 Transfer modes
- **Direct P2P:** one PeerConnection + DataChannel per receiver; sender uploads one stream per receiver.
- **TURN relay:** per-receiver relayed stream; TURN stores nothing and does not reduce sender upload.
- **Cloud Distribution:** optional store-and-forward via S3-compatible storage, **signed-in senders only**, consented, cost-estimated, client-side encrypted with a per-file key shared to joined receivers over signaling, TTL and budget enforced, deleted after completion/expiry.
- **P2P cascade:** out of scope.

### 6.3 Route strategy (client-side, per receiver)
Candidate order: Direct P2P → TURN UDP → TURN TCP/TLS 443 → Cloud (if the sender is signed in, has enabled and consented, and is within budget) → queue/retry. For guest senders the Cloud step is skipped. This is a policy, not a claim that the first option is always fastest; compare observed throughput, reliability, constraints, and cost. Use hysteresis and cooldown; switch only on failure or sustained material improvement. The client reports the chosen route to the server for metrics.

### 6.4 Large-file streaming
- Never load whole files into memory; stream with block-based I/O.
- Block size 4 MiB (configurable, benchmarked). Transport frame 64 KiB initially; `bufferedAmountLowThreshold` backpressure; validate real DataChannel message limits per browser pair.
- Bounded buffers and per-peer flow control; per-receiver ACK and retry state.
- SHA-256 per block and whole file. Receiver ACKs a block only after write + verify.
- Receiver persists a completed-block bitmap (IndexedDB on Web, Room/file on Android, a sidecar file next to the partial download on iOS).
- Resume exchanges the missing-block bitmap, not a last-chunk number; handle out-of-order blocks and holes.
- After route migration: reconnect, authenticate the transfer with its capability, exchange bitmap, send missing blocks.
- Conservative initial concurrency; benchmark on 2 GB-RAM Android devices; do not hard-code by RAM tier.

Block count sanity: 20 GB / 4 MiB = 5120 blocks → 640-byte bitmap.

### 6.5 Metrics and ETA
Measure at clients: candidate pair type, connection state, RTT, effective throughput, loss/retransmit indicators, `bufferedAmount`, ACK rate, verified bytes. Smooth with EWMA. ETA = remaining verified bytes / effective throughput, provisional at first, hidden during disconnect/negotiation; group ETA follows the slowest active receiver. No large pre-transfer speed tests.

### 6.6 Cloud cost and consent
Cloud Distribution requires a signed-in sender (§2). The server rejects `POST /v1/files/{id}/distribute` from a token without `acct` with `403 cloud_requires_account`. Before Cloud Distribution: show estimated temporary storage, receiver egress, retention, estimated cost or "cost unknown"; require explicit consent; enforce budget cap; on exhaustion pause and offer alternatives. Provider pricing is configuration, never hard-coded facts.

### 6.7 TURN credentials
Guests may use TURN, otherwise many guests behind symmetric NAT could not transfer at all. Credentials are time-limited coturn HMAC credentials for the sender and joined receivers of an active session, with tighter TTL, issue limits, and relay byte caps for guests. Mechanics in `docs/ARCHITECTURE.md` §6; limits in `docs/SECURITY_MODEL.md` §5 and §6.

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

### 7.3b iOS constraints
`UIPasteboard.general` is readable only while the app is foreground; iOS 16+ shows a system paste banner on programmatic reads not triggered by `UIPasteControl`. Observe `UIPasteboard.changedNotification` and `changeCount` while the scene is active; never poll in background. Use `detectPatterns(for:)` / `detectedPatterns` to classify (URL, number, probable secret shape) before reading content. Honor Universal Clipboard content the same as local content. There is no background clipboard access; state this in UI.

### 7.4 Protocol and data model
Each capture is an immutable event: `event_id (UUID), user_id, origin_device_id, event_type (TEXT), mime_type, ciphertext, nonce, key_version, payload_size, created_at, expires_at, seq`.

Ordering **(v2 resolution of the sequence-ordering caveat):** `seq` is a per-user monotonically increasing integer assigned inside the insert transaction while holding `pg_advisory_xact_lock(hashtext(user_id))`. This serializes inserts per user so `seq` order equals commit order, and a cursor can safely be `last_seq`. Idempotency on `event_id`. Per-device cursor in `clipboard_device_cursors`. Offline retries must not duplicate events.

REST: `POST /v1/clipboard/events`, `GET /v1/clipboard/events?cursor=`, `GET /v1/clipboard/history`, `DELETE /v1/clipboard/events/{id}`, `DELETE /v1/clipboard/history`, `GET|PUT /v1/clipboard/settings`.
WS: `CLIPBOARD_EVENT_CREATED, CLIPBOARD_EVENT_DELETED, CLIPBOARD_HISTORY_CLEARED, CLIPBOARD_SETTINGS_UPDATED, DEVICE_CONNECTED, DEVICE_DISCONNECTED`. WS carries metadata only; ciphertext is fetched over HTTPS.

### 7.5 Encryption and keys
- Account Data Key (ADK): 256-bit, generated client-side on the first device at account creation. Versioned (`key_version`). Subkeys via HKDF-SHA256: `clipboard-v1` for clipboard items, `history-v1` for cloud history entries.
- Per item: AES-256-GCM, random 96-bit nonce, AAD = `event_id || key_version` (clipboard) or `entry_id || key_version` (history).
- Guests have no ADK and no clipboard or cloud history; nothing is encrypted with device identity keys.
- Web: WebCrypto non-extractable `CryptoKey` persisted in IndexedDB; document eviction risk.
- Android: ADK wrapped by an Android Keystore AES key.
- iOS: ADK wrapped by a Secure Enclave `P256.KeyAgreement` derived key via CryptoKit, stored in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; excluded from iCloud Keychain and backups.
- New device pairing (both devices signed in to the same account and added to it): new device shows a QR with an ephemeral X25519 public key and a device-pairing token; the existing signed-in device scans it, derives a shared secret (HKDF), wraps the ADK, and uploads the wrapped blob to the server for one-time pickup. Fallback: the user types the 12-word recovery phrase, which unwraps a server-stored recovery-wrapped copy of the ADK (Argon2id on the phrase).
- Revoking a device bumps `key_version`: a new ADK is generated by the revoking device, wrapped for every remaining device, and old events stay readable with the old version.
- Never put plaintext keys in localStorage, source, analytics, or logs. If all devices and the phrase are lost, old history is unrecoverable; say so in UI.

### 7.6 Safety defaults
Text only; ≤ 256 KB enforced client and server; cap 100 items; 7-day retention; skip platform-flagged sensitive clips; best-effort secret heuristics (OTP-like, token-like) with an honest disclaimer; no plaintext logs; no auto remote write; user can pause sync and clear history.

## 8. Identity, data model, API, and abuse controls

These are specified in their own documents. This section only states the requirements they must satisfy.

- **Identity:** every installation has an anonymous, server-signed device identity; accounts are layered on top. See `docs/SECURITY_MODEL.md` §4 and `docs/ARCHITECTURE.md` §3.
- **Data model:** sessions are owned by a device; `user_id` is never required for file sharing. See `docs/ARCHITECTURE.md` §8.
- **Join modes and lifetimes:** open join by default, Require approval optional, protected mode, lifetimes. See `docs/SECURITY_MODEL.md` §3 and §6.
- **Rate limits:** see `docs/SECURITY_MODEL.md` §5.
- **API and access levels:** every endpoint declares `public`, `device`, `participant`, `account`, or `account+device`. See `docs/API.md`.

## 9. Visual design requirements

**Web shell:** brand mark and wordmark, main nav, identity chip ("Guest" + Sign in, or account menu), theme selector, responsive sidebar/topbar, page title and primary action.
**Account-required intro:** one reusable component on all platforms for the Clipboard tab, the Devices account section, and disabled Settings sections: icon, headline, two-sentence benefit, privacy line, Sign in and Create account buttons. It is an informational state, never styled as an error.
**Transfer dashboard:** prominent Send/Receive, active transfer summary, session card, device/network indicators, first-run empty state.
**Send session:** drag-and-drop + picker, file list with icon/name/size/remove, total size, Require approval toggle, create action, QR/code/copy-link panel with code countdown, live participant list with verification words and Remove/Block, request cards when approval is on, capacity indicator, Stop accepting, keep-screen-on status row.
**Active transfer:** keep-screen-on status row; overall, per-receiver, per-file progress; route badge (Direct / Relay / Cloud); throughput and ETA with uncertainty state; pause/resume/retry/cancel; details/error drawer; restrained completion state.
**Receive page:** sender details, file preview, Receive action, approval wait only when approval is on, destination/permission guidance, progress and verification, keep-screen-on status row.
**Clipboard:** Sync button, capture status with capability explanation, item timeline with device and time, truncated preview, Copy, search/filter, clear history, privacy hints.
**History / Devices / Settings:** usable, coherent screens.
**Android:** all equivalent screens in Compose with state hoisting; long-running work out of composables.
**iOS:** all equivalent screens in SwiftUI with `@Observable` view models, engine work on structured-concurrency tasks off the main actor, Human Interface Guidelines patterns while keeping the Share Anywhere identity.

Microcopy: "Get started", "No account needed to send or receive files", "Guest", "Sign in to sync your clipboard", "Stored on this device only", "Sign in to use Cloud transfer", "Send files", "Receive files", "Calm Otter joined", "Remove", "Block", "Require approval", "Everyone here? Stop accepting new receivers", "Waiting for the sender to let you in", "Screen stays on during this transfer", "Keep this tab open and visible", "Locking your iPhone pauses the transfer", "Connected directly", "Using relay", "Cloud transfer requires your approval", "Sync Clipboard", "Automatic capture is available when your browser permits it", "Open Share Anywhere to sync clipboard", "Your clipboard content is encrypted before sync". Never "Always syncing".

## 10. Accessibility and localization

Keyboard navigation; screen reader labels and landmarks (VoiceOver labels and traits on iOS); focus management in dialogs; no color-only status; touch targets ≥ 48 dp / 44 pt; system font scaling and Dynamic Type; reduced motion; English and Vietnamese catalogs (`web/src/i18n/{en,vi}.json`, Android `values/`, `values-vi/`, iOS `Localizable.xcstrings`); no concatenated fragments; tested breakpoints; QR and code usable on small viewports.

## 11. Security requirements

Security is a product feature. The controls, join-mode analysis, lifetimes, rate limits, threat model, residual risks, and privacy rules are in `docs/SECURITY_MODEL.md`. Requirements that product work must respect:
- File sharing never requires an account; account-only features are exactly those in §2.
- Open join is the default; its protections (code rotation, lockouts, protected mode, five-receiver cap, verification words, Remove/Block) are mandatory, not optional hardening.
- Every route enforces its declared access level (`docs/API.md` §1).
- Clipboard and cloud history are account-only and end-to-end encrypted.
- `docs/SECURITY_MODEL.md` is extended by Phases 1, 2, 5A, 5B, and 8 and reviewed end to end in Phase 9.

## 12. Observability

No file content or clipboard plaintext in telemetry. IP addresses are used for rate limiting in memory only; logs store a keyed hash of the IP truncated to /24 (IPv4) or /48 (IPv6) with 7-day retention. Guest and account metrics are aggregated, never per person. Metrics: anonymous device creations, proof-of-work challenges issued, 429 counts per limiter, failed code lookups, lockouts, protected-mode activations and duration, joins by mode (open, approval, protected) and by channel (code, link, QR), Remove and Block counts, wake lock outcomes on Web (granted, refused, unsupported) by browser family, session create/join/approve counts split by guest vs signed-in sender, route outcomes, completion/failure rates, reconnect/resume success, throughput buckets, TURN bytes, cloud consent and estimates, clipboard event counts and sync latency, browser permission failures by family. No third-party analytics without an explicit decision. Prometheus endpoint `/metrics` on the backend; dashboards are post-MVP.

## 13. Acceptance test matrix

Mapped to CI jobs in `docs/TESTING_AND_CI.md`.

**Guest-first:** first launch goes Welcome → Transfer home with no sign-in screen on Web, Android, and iOS; join link on first visit skips Welcome; guest sender and guest receiver complete a transfer without any account on every client pair; anonymous identity survives reload/restart; refresh rotation and reuse detection; reset device identity; History stored locally for guests and survives restart; Settings shows Guest and Sign in; Clipboard tab shows the intro for guests and makes no clipboard API or permission calls; clipboard, history-sync, devices-list, and keys endpoints return `403 account_required` for guest tokens and `403 device_not_added` for signed-in but not-added devices; Cloud distribute as guest returns `403 cloud_requires_account` and the UI shows the disabled option; guest receiver who joined can download a cloud-distributed file; sign-in during an active transfer does not interrupt it; post-sign-in choices (add device on/off, copy history on/off) behave as specified; sign-out issues a new device ID and wipes ADK material.
**Abuse and rate limits:** anonymous device creation limit and proof-of-work; session creation limit; concurrent open sessions per device; code lookup limits and lockout; failed-lookup lockouts per IP and per device; protected mode trips on the global guess rate and forces approval for code joins only; join limit and per-session pending cap when approval is on; Block refuses rejoin from the same device and from a new identity on the same IP /64; TURN credential refused for non-joined or non-active participants and when over limit; WebSocket connection caps; `Retry-After` present and shown in UI; `X-Forwarded-For` ignored from untrusted sources; every route enforces its declared `x-sa-access` level.
**Join and pairing:** open join by code, link, and QR starts receiving without any sender action; Require approval off by default; with approval on, receiver waits, then approve and reject both work; toggling Require approval affects only future joins; Remove stops the transfer and frees the slot; Block refuses rejoin; Stop accepting kills the code and link; code expires after 5 minutes and when the session is full; expired link; invalid code; verification words match on both sides; join toast and background notification for the sender; sender closes; session lifetimes (waiting, idle, max); sixth receiver rejected atomically under concurrency.
**Keep screen on:** held while waiting for receivers, waiting for approval, sending, and receiving on Web, Android, and iOS; released automatically on completion, failure, pause, cancel, session close or expiry, and removal; setting off means never held; Web re-requests after the tab becomes visible again; Web wake lock unsupported shows the reminder; Web wake lock refused (`NotAllowedError`) shows the refused status; Android flag set only while a transfer screen is visible and the transfer continues with the screen off; iOS idle timer reset on background and restored on foreground; status row text matches the state.
**Transfer:** Web→Web; Android→Web; Web→Android; iOS→Web; Web→iOS; Android↔iOS (nightly); multiple files; empty/unsupported file; read permission revoked; storage full; sender disconnect; receiver disconnect; pause/resume; out-of-order blocks; missing-block bitmap; checksum mismatch; reconnect and route migration; slow receiver does not stall others; five concurrent receivers; forced TURN relay.
**Clipboard (signed in, device added):** Web manual capture; Web auto best-effort; permission denied; insecure/unsupported context; in-page copy event only; no false universal-observation claim; Android foreground capture; Android background restriction; Android manual action; iOS foreground capture; iOS background non-capture; iOS `UIPasteControl` sync without banner; iOS fallback button path; sensitive skipped; duplicate event idempotency; remote item shown; explicit Copy writes; no auto-overwrite; offline queue and reconnect; expiry and deletion; ciphertext undecryptable without client key; new-device pairing; recovery phrase; revoke and rotate; encrypted cloud history round-trip and import of local history.
**UX:** all states, each in guest and signed-in variants where they differ; keyboard; screen reader labels (TalkBack, VoiceOver); responsive (desktop, Pixel 7, iPhone 14 browser profiles; iPhone SE and iPhone 15 Pro Max simulators); Dynamic Type; dark/light; EN/VI.
