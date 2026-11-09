# Share Anywhere — Product Requirements

This document is the source of truth for **what** to build. **How and when** is in `docs/phases/`. Standing engineering rules are in `CLAUDE.md`. Sections are numbered so phase files can reference them (for example "PRD §6.4").

---

## 1. Vision

Share Anywhere lets people transfer large files between devices and synchronize text clipboard history across their own devices, without requiring every device to be on the same local network.

Core value:
- **Guest-first file sharing:** open the app or the website and send or receive immediately. No account, no sign-in wall.
- Share large files (4–20 GB target) across Android, iOS, and Web.
- Join a session with QR code, six-digit code, or HTTPS share link.
- Sender explicitly approves every receiver.
- One sender to one receiver, or one sender to up to **five** simultaneous receivers.
- Prefer direct P2P; fall back to TURN relay; optional Cloud Distribution only with explicit consent.
- Resume interrupted transfers without retransmitting verified blocks.
- Clipboard Sync between Android, iOS, and Share Anywhere Web with a hybrid, permission-aware approach. This is the **only** core feature that requires an account, together with the account-wide Devices list and cloud-synced history.

The product should feel trustworthy, fast, simple, and technically capable, not like a developer dashboard.

## 2. Explicit product decisions — do not change silently

Decisions marked **(v2)** were open in the first brief and are now fixed. Decisions marked **(v3)** were added or changed later; the guest-first identity model is a v3 change and supersedes the earlier "guests receive-only" rule.

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
| Approval | Sender approves each receiver |
| Route selection | Per receiver, decided by the **client**, recorded by the server |
| Route preference | Direct P2P → TURN UDP → TURN TCP/TLS 443 → Cloud (consented) → queue/retry |
| Cloud Distribution **(v3)** | Optional, disabled until consent, budget-capped, client-side encrypted. **The sender must be signed in** to use it (cost attribution, budget cap, storage-abuse control, retention). Guest receivers may download cloud-distributed files from a session they were approved into. Guests see the Cloud option disabled with "Sign in to use Cloud transfer". |
| Guest-first file sharing **(v3)** | Sending and receiving files **never require an account** on Web, Android, or iOS. First launch shows a single Welcome screen whose only action leads straight to Transfer home. No sign-in screen sits in front of any transfer flow. Adding an account requirement to any Transfer flow is a product-decision change and needs an ADR. |
| Account-only features **(v3)** | Exactly these require Sign in / Create account: Clipboard Sync, the account-wide Devices list (other devices, revoke, pairing), cloud-synced transfer history, and Cloud Distribution as a sender. Everything else works as a guest. |
| Device identity **(v3)** | Every installation or browser profile gets an **anonymous device identity** on first launch: a server-issued device ID, a short-lived signed **device access token** (JWT, EdDSA/Ed25519, 15 min TTL, strict algorithm allowlist, `kid` for key rotation), and a long-lived **device refresh secret** (256-bit, hashed at rest, rotated on every use, reuse detection revokes the device). Anonymous identities expire after 30 days without use. Details in §8.1. |
| Authentication **(v3)** | Email + password (Argon2id) for accounts. An account session is **layered on top of** the device identity: after sign-in the device access token carries an `acct` claim. All API calls use the bearer access token; the Web keeps the refresh secret in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to the refresh endpoint and holds the access token in memory only. Native apps keep the refresh secret in Android Keystore-backed storage or the iOS Keychain. **No email verification in v1** (structure present, disabled). Password reset via emailed link behind a mail adapter with a dev-mode console/mailpit sink. |
| Signing in on a device **(v3)** | Sign-in never interrupts an active transfer (the device ID does not change). After sign-in the user chooses: **"Add this device to your account"** (default on; required for Clipboard Sync on this device and for it to appear as trusted in Devices) and **"Copy this device's transfer history to your account"** (default off; shown only when the device is added). A signed-in but not-added device gets a short account session (24 h max, browser-session cookie on Web) and sees "Add this device to use Clipboard Sync". |
| Signing out **(v3)** | Removes the device from the account, deletes local account key material, revokes the account session, and issues a **fresh anonymous identity** (new device ID) so guest activity after sign-out cannot be linked to the account. Local history is kept or cleared at the user's choice. |
| History **(v3)** | Always stored **locally** on the device (IndexedDB on Web, Room on Android, Core Data or GRDB on iOS; iOS 16 rules out SwiftData). Signed-in users can turn on **cloud history sync**, which uploads end-to-end encrypted entries (§7.5). The server's own session records are operational, not history, and are purged 7 days after a session ends. |
| Abuse controls for anonymous use **(v3)** | Rate limits keyed by IP (IPv6 by /64) **and** by device for device creation, session creation, six-digit code lookup, join requests, TURN credentials, and WebSocket connections (§8.4); proof-of-work challenge on anonymous device creation when an IP exceeds its soft limit (third-party CAPTCHA only through an optional adapter, off by default); per-session pending-request cap and sender-side block; strict session TTLs (§8.3). |
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

All three clients open on **Transfer home** for guests and signed-in users alike. The navigation is identical for both; account-only content appears inside the tabs, never as a gate in front of the app.

**Web** main navigation: Transfer, Clipboard, History, Devices, Settings. Header identity chip: "Guest" with a **Sign in** button, or the account name with a menu (profile, security, sign out). Desktop: sidebar + content. Small screens: compact nav + stacked panels. Routes: `/` (Transfer home), `/welcome` (first visit only), `/send`, `/receive`, `/join/:token`, `/join` (code entry), `/clipboard`, `/history`, `/devices`, `/settings`, `/signin`, `/signup`, `/reset`. Every route except `/clipboard` content, account sections of `/devices`, and account sections of `/settings` is fully usable as a guest. `/signin` and `/signup` accept a `returnTo` parameter so the user lands back where they started.

**Android** bottom navigation: Transfer, Clipboard, History, Devices, Settings; start destination Transfer home, with the Welcome screen shown once before it on first launch. Sign-in screens are a separate nested graph reached only from account CTAs. System back behavior, permission education, foreground service only for active transfers, lifecycle-safe state.

**iOS** `TabView`: Transfer, Clipboard, History, Devices, Settings; Transfer selected on launch, Welcome shown once as a full-screen cover on first launch. Sign-in is presented as a sheet from account CTAs. `NavigationStack` per tab, system gestures, permission education for camera (QR) and notifications, scene-phase-aware state so a transfer pauses cleanly when the app leaves the foreground.

## 5. Screen inventory

Every screen includes loading, empty, populated, error, offline, and permission-denied states where applicable.

### 5.1 Onboarding (guest-first)
1. **Welcome** (first launch only): value proposition in one screen, a one-line privacy note ("Files go directly between devices when possible. No account needed."), and a single primary action **Get started** that opens Transfer home. A secondary text link "Already have an account? Sign in" is allowed but optional and never required.
2. Anonymous device identity is created silently in the background while Welcome is shown (§8.1). If creation fails (offline, rate-limited, proof-of-work), Transfer home still opens and shows an inline retry state; local features (History, Settings) keep working.
3. Device display name is auto-generated (platform model + two random words, for example "Pixel 7 · Calm Otter") and editable later in Devices or Settings. It is shown to the other side during approval.
4. Permissions are requested **just in time**: camera when the user taps Scan QR, notifications when a transfer starts (Android 13+ `POST_NOTIFICATIONS`, iOS provisional or explicit), local network never requested.
5. No first-run checklist that blocks usage; an optional dismissible tips card on Transfer home is allowed.

### 5.1b Account screens (reached only from account CTAs)
Sign in; Create account; Forgot/reset password; post-sign-in choices sheet ("Add this device to your account", "Copy this device's transfer history to your account"); Account Data Key setup with recovery phrase (first device) or device pairing / recovery phrase entry (additional device); Sign out confirmation with "Keep local history" / "Clear local history". Entry points: header/Settings Sign in button, Clipboard tab intro, Devices tab account section, History "Sync history across devices" banner, Cloud option in a send session.

### 5.2 Transfer home
Two primary actions: **Send files**, **Receive files**. Also: active transfers, recent transfers from local history, transfer strategy status, usage/permission guidance. Must not overwhelm new users. Identical for guests and signed-in users; no account prompt on this screen beyond the header identity chip.

### 5.3 Send flow
1. Select files (Android document picker / Web file picker + drag-and-drop).
2. Review selection (name, type, size, total).
3. Create Share Session.
4. Show QR, six-digit code, HTTPS share link, remaining receiver slots.
5. Waiting for receivers.
6. Receiver request card: device display name, platform, identity badge (**Guest** or **Signed in**, the latter with the account's display name), and two **verification words** that the receiver also sees on their waiting screen so both people can confirm they are approving the right device.
7. Approve / reject / block (block prevents that device from requesting again in this session).
8. Participant list (max 5).
9. Per-receiver route/connection status.
10. Transfer dashboard.
11. Completed / partially completed / failed / paused / cancelled.
12. Close/expire confirmation.

Rules: works without an account; approval mandatory for guest and signed-in receivers alike; six-digit code is lookup only; links/QR carry capability tokens; expired/revoked/rejected/closed sessions grant nothing; UI never implies access before approval; the Cloud option is visible but disabled for guests with "Sign in to use Cloud transfer".

### 5.4 Receive flow
1. Scan QR (Android) / 2. Enter code / 3. Open share link (Web join page).
4. Preview sender identity (display name, Guest/Signed in badge) and file list (names, sizes, count; nothing else before approval).
5. Request access (no account needed). 6. Waiting for approval, showing the same two verification words the sender sees. 7. Approved / rejected / blocked / expired / session full.
8. Choose destination (Android SAF / iOS Files destination or app Documents / browser save target per §6.8 capability).
9. Receiving progress. 10. Pause/resume/retry. 11. Verification. 12. Completed / failed / partial.
13. Open/share/locate file where the platform allows.

Web join: if the Android or iOS app is installed and App Links / Universal Links are verified, open it; otherwise show the Web Join Page. A first-time visitor arriving on a join link skips Welcome entirely and lands on the join preview; the anonymous identity is created in the background. Detect and explain browser capability limits **before** starting the transfer. Never promise background downloads in mobile browsers.

### 5.5 Multi-receiver dashboard
Session ID and status; sender device; each participant and approval state; each file; one transfer card per file–recipient pair; per-recipient progress, speed, ETA, route, retry, error; aggregate progress; pause/resume/remove per receiver; stop all / close session. A slow or disconnected receiver never blocks others.

Session states: `CREATED, WAITING, ACTIVE, COMPLETED, PARTIALLY_COMPLETED, CLOSED, EXPIRED, CANCELLED`.
Transfer states: `PENDING, ACCEPTED, CONNECTING, TRANSFERRING, PAUSED, RESUMING, DISCONNECTED, RECONNECTING, COMPLETED, FAILED, CANCELLED`.
Participant states: `REQUESTED, APPROVED, REJECTED, LEFT, REMOVED`.

### 5.6 History
Past sessions and transfers; search/filter by date, peer device, status, file name; direction, bytes, peer, result; reopen details; delete entries; clear all. Distinguish transferred bytes from file size for partial transfers.
- **Guest:** entries live only in local storage on this device; a subtle banner "Stored on this device only. Sign in to sync history across your devices." with a Sign in action. Retention setting (default 90 days) and Clear history in Settings.
- **Signed in, cloud sync off:** same as guest, banner offers "Turn on history sync".
- **Signed in, cloud sync on:** merged view of local and synced entries, each entry marked with its origin device; deleting an entry deletes it everywhere after confirmation.

### 5.7 Devices
- **Guest:** a "This device" card (display name, platform, anonymous since date) with Rename and "Reset device identity" (issues a new anonymous identity; ongoing sessions end). Below it an intro: "Sign in to see and manage all your devices and sync your clipboard between them" with **Sign in** and **Create account**.
- **Signed in, device added:** list of account devices (name, platform, last seen, trust state); rename; revoke; current device marked; "Pair a new device" for the Account Data Key; explain revocation impact. Revocation stops access to future clipboard and history events and triggers key rotation (§7.5).
- **Signed in, device not added:** account device list (read-only for this device) plus "Add this device to your account".

### 5.8 Settings
- Identity header: **"Guest"** with a short explanation and a **Sign in** button (plus "Create account"), or the account name and email with Account/security, Sign out.
- Available to everyone: device display name; theme system/light/dark; language EN/VI; notifications; transfer strategy (Auto default); data/battery; local history retention and Clear history; privacy; about/version/licenses.
- Account-only sections, shown disabled with a Sign in action for guests: Cloud Distribution (off until consent, budget cap); history sync; clipboard settings; manage devices.

### 5.9 Clipboard screens
**Guest (all platforms):** the Clipboard tab shows an intro screen, not an error: what Clipboard Sync does, that it is end-to-end encrypted, that it needs an account so your devices can find each other, and two buttons **Sign in** and **Create account** (returning to the Clipboard tab afterwards). No clipboard reads, no permission prompts, and no clipboard API calls happen for guests.
**Signed in, device not added:** intro variant with "Add this device to use Clipboard Sync".
**Signed in, device added, ADK not yet on this device:** pairing / recovery phrase screen before history appears.

**Web:** history; manual Sync action; browser permission/capability status; automatic capture toggle; item detail; Copy; search/filter; clear history confirmation; privacy settings; empty/offline/error.
**Android:** history; foreground capture status; Sync action; notification action entry; item detail and Copy; search/filter; retention; sensitive-item-skipped state; empty/offline/error.
**iOS:** same as Android, with `UIPasteControl` as the primary Sync control, a "paste banner" explanation for the fallback button, and a Home Screen quick action / widget deep link that opens the app for a user-driven sync.
Clipboard UX must always state whether capture is automatic, best-effort, or manual.

## 6. File transfer

### 6.1 Architecture
Go control plane: REST for device identity, accounts, sessions, participants, files, transfers; WebSocket for signaling and control events; PostgreSQL for durable metadata; coturn for TURN. Redis is not used in MVP. Clients own the transfer engine (chunking, hashing, flow control, route selection, ETA).

### 6.2 Transfer modes
- **Direct P2P:** one PeerConnection + DataChannel per receiver; sender uploads one stream per receiver.
- **TURN relay:** per-receiver relayed stream; TURN stores nothing and does not reduce sender upload.
- **Cloud Distribution:** optional store-and-forward via S3-compatible storage, **signed-in senders only**, consented, cost-estimated, client-side encrypted with a per-file key shared to approved receivers over signaling, TTL and budget enforced, deleted after completion/expiry.
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
coturn `use-auth-secret` with HMAC time-limited credentials issued by `backend/internal/turncreds` only to the sender and approved receivers of an `ACTIVE` session, scoped username `expiry:participant_id`. Guests are allowed TURN (otherwise many guests behind symmetric NAT could not transfer at all) with tighter limits:

| | Guest device | Account device |
|---|---|---|
| Credential TTL | 30 min | 60 min |
| Credential requests | 20 / hour / device | 60 / hour / device |
| coturn `user-quota` (allocations per username) | 6 | 6 |
| Relay bytes per session (Phase 8, enforced by stopping renewal) | `GUEST_RELAY_BYTES_CAP`, default 25 GB | `ACCOUNT_RELAY_BYTES_CAP`, default 100 GB |

All values are configuration, documented in `.env.example`.

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

### 8.1 Device identity model
- **Bootstrap:** `POST /v1/devices/anonymous` with `platform`, `display_name`, and, when the server demands it, a solved proof-of-work challenge from `GET /v1/devices/anonymous/challenge`. Returns `device_id`, an access token, and a refresh secret. Rate-limited per IP (§8.4).
- **Access token:** JWT signed with Ed25519 (`alg: EdDSA` only; any other `alg` is rejected), 15-minute TTL. Claims: `sub` = device ID, `typ` = `device`, `gen` = refresh generation, `acct` = user ID (present only with an active account session), `dl` = whether the device is added to that account, `kid`. Signing keys rotate via `kid` with a JWKS-style internal key set; private keys come from configuration, never the repository.
- **Refresh:** `POST /v1/devices/token` with the refresh secret. Each refresh returns a new secret and invalidates the previous one; presenting an already-used secret revokes the device and all its sessions (reuse detection). Web sends the secret via the `sa_device` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/v1/devices/token`) and must also send the header `X-SA-Refresh: 1`, which cross-site pages cannot send without a CORS preflight the server refuses.
- **Lifetimes:** anonymous device refresh secret expires after 30 days without use; account-added device after 90 days without use. Inactive anonymous device rows are purged after 30 days.
- **Account session:** sign-in or sign-up is called with the current device token, creates an `auth_sessions` row bound to that device, and the next access token carries `acct` (and `dl` if the device was added). Sign-out revokes the account session, removes the device from the account, and returns a brand-new anonymous identity.
- **WebSocket:** browsers cannot set headers on WebSocket upgrades, so clients call `POST /v1/ws/ticket` (device token) to receive a one-time ticket valid for 30 seconds, then connect to `/v1/ws?ticket=…`. The server checks `Origin`, consumes the ticket, and binds the socket to the device (and account, if any).

### 8.2 Tables
Core (guest and account):
- `devices(id, kind anonymous|account, user_id NULL, display_name, platform, refresh_secret_hash, refresh_generation, created_at, last_seen_at, expires_at, revoked_at)` with `CHECK ((kind='account') = (user_id IS NOT NULL))`.
- `share_sessions(id, owner_device_id NOT NULL, owner_user_id NULL, status, code_hmac NULL, code_expires_at, accepting_receivers, created_at, expires_at, ended_at, purge_after)`; `owner_user_id` is set only when the sender was signed in at creation and is used for Cloud and per-account limits, never required.
- `session_participants(id, session_id, device_id NOT NULL, user_id NULL, role sender|receiver, status, verification_words, requested_at, decided_at)` with `UNIQUE(session_id, device_id)`.
- `session_blocks(session_id, device_id)`; `shared_files`; `transfers(participant_id, file_id, status, verified_bytes, route, …)`; `session_events`; `capability_tokens(id, session_id, participant_id NULL, purpose join|transfer, token_hash, expires_at, revoked_at)`.
Account-only:
- `users`, `auth_sessions(id, user_id, device_id, device_added, created_at, last_used_at, expires_at, revoked_at)`, `password_resets`, `account_keys` (wrapped ADK per device, recovery-wrapped copy, `key_version`), `device_pairings`, `clipboard_events`, `clipboard_device_cursors`, `clipboard_settings`, `history_entries(id, user_id, origin_device_id, ciphertext, nonce, key_version, seq, created_at, deleted_at)`, `cloud_settings`, `cloud_objects`.

Constraints: atomic max-5 receiver slots per session (`SELECT … FOR UPDATE` on the session row, count `REQUESTED` + `APPROVED` receivers, insert); per-session pending-request cap; participant approved before any file or signaling access; capability token separate from six-digit code, hashed at rest, single-purpose, expiring, revocable; six-digit code stored as an HMAC with a server pepper, unique among live sessions; idempotent state transitions; authorization on every resource; no trust in client-supplied identities. `history_entries.seq` uses the same per-user advisory-lock pattern as clipboard (§7.4).

### 8.3 Session lifetimes
| Item | Lifetime |
|---|---|
| Join capability token in link/QR | 15 min, renewable by the sender while the session accepts receivers |
| Six-digit code | Rotates every 10 min; valid only while the session accepts receivers; disabled when 5 slots are taken or the sender stops accepting |
| Join ticket returned by a code/link lookup | 5 min, single use |
| `WAITING` with no approved receiver | Expires after 30 min |
| Session idle (no connected participant) | Expires after 30 min |
| Maximum session lifetime | Guest sender 24 h; signed-in sender 72 h |
| Transfer capability (resume) | Bound to participant, valid until the session ends |
| Server-side session records, including file names | Purged 7 days after the session ends |
| Concurrent open sessions per device | Guest 2; signed-in 5 |

### 8.4 Rate limits (defaults; all configurable)
Token buckets keyed as listed. IPv6 addresses are keyed by /64. The client IP is taken from `X-Forwarded-For` only when the request comes from the trusted Caddy proxy. Responses use `429 rate_limited` with `Retry-After`; clients show a friendly message with the wait time. MVP keeps buckets in process memory (single backend instance); a multi-instance deployment must move them to PostgreSQL or Redis and that change needs an ADR.

| Action | Keys and limits |
|---|---|
| Anonymous device creation | IP: 10 / hour, burst 3; proof-of-work required beyond 3 / hour |
| Token refresh | Device: 60 / hour |
| Session creation | Device: 10 / hour; IP: 30 / hour |
| Code lookup | IP: 10 / min and 60 / hour; device: 5 / min; 20 failed lookups / hour from an IP → 15-min lockout; global failed-lookup rate alarm in metrics |
| Join requests | Device: 10 / min; per session at most 10 pending requests |
| TURN credentials | See §6.7 |
| WebSocket | IP: 20 concurrent; device: 3 concurrent; 50 messages / s per socket |
| Sign-in | IP + email: 5 / 15 min; IP: 30 / hour |
| Sign-up | IP: 5 / hour |
| Password reset request | Email: 3 / hour; IP: 10 / hour |
| Clipboard event creation | Device: 120 / min |

### 8.5 API access levels
Final contract in `shared/protocol/openapi.yaml`; every operation declares one of these levels with an `x-sa-access` extension, and a backend test asserts each route enforces its declared level.

| Level | Meaning | Rejection |
|---|---|---|
| `public` | No token | — |
| `device` | Any valid device access token, guest or signed in | `401 device_token_invalid` / `device_token_expired` |
| `participant` | `device` + the device is the sender or a receiver participant of the session; data and actions are further limited by role and approval state (a `REQUESTED` receiver sees only the preview and its own status; file metadata, transfers, and TURN need `APPROVED`) | `404` (existence hidden) |
| `account` | Token with `acct` | `403 account_required` |
| `account+device` | Token with `acct` and `dl=true` | `403 device_not_added` |

| Endpoint | Level |
|---|---|
| `GET /healthz`, `GET /readyz` | public |
| `GET /v1/devices/anonymous/challenge`, `POST /v1/devices/anonymous` | public |
| `POST /v1/devices/token` | public (refresh secret) |
| `POST /v1/auth/password-reset/request`, `POST /v1/auth/password-reset/confirm` | public |
| `GET / PATCH /v1/devices/current`, `POST /v1/devices/current/reset` | device |
| `POST /v1/ws/ticket` | device |
| `POST /v1/auth/signup`, `POST /v1/auth/signin` | device (binds the account session to the calling device) |
| `POST /v1/sessions` | device |
| `POST /v1/sessions/join` (code), `POST /v1/sessions/join-link` (token) → preview + join ticket | device |
| `POST /v1/sessions/{id}/request-access` (join ticket) | device |
| `GET /v1/sessions/{id}` | participant |
| `POST /v1/sessions/{id}/close`, `/renew`, `/stop-accepting` | participant (sender) |
| `POST /v1/participants/{id}/approve`, `/reject`, `/block`; `DELETE /v1/participants/{id}` | participant (sender) |
| `POST /v1/participants/{id}/leave` | participant (that receiver) |
| `POST / GET /v1/sessions/{id}/files`, `DELETE /v1/files/{id}` | participant (sender writes; approved receivers read) |
| `GET /v1/sessions/{id}/transfers`, `GET /v1/transfers/{id}`, `POST /v1/transfers/{id}/pause`, `/resume`, `/cancel`, `/report` | participant (approved); resume also requires the transfer capability |
| `POST /v1/turn/credentials` | participant (sender or approved receiver of an `ACTIVE` session) |
| `POST /v1/files/{id}/distribute`, `GET / PUT /v1/cloud/settings` | account (sender); guests get `403 cloud_requires_account` |
| `GET /v1/cloud/objects/{id}` (download URL for an approved receiver) | participant |
| `POST /v1/auth/signout`, `GET / PATCH /v1/me`, `POST /v1/me/password` | account |
| `GET /v1/devices`, `PATCH / DELETE /v1/devices/{id}`, `POST /v1/devices/current/add` | account |
| `/v1/keys/*` (wrapped ADK, pairings, recovery) | account+device |
| `/v1/history/entries*` (cloud history) | account+device |
| `/v1/clipboard/*` | account+device |

WebSocket events: session-room events (`OFFER`, `ANSWER`, `ICE_CANDIDATE`, participant and session events) are delivered to `participant` sockets; account events (`CLIPBOARD_*`, `HISTORY_*`, `DEVICE_CONNECTED/DISCONNECTED`) only to `account+device` sockets.

## 9. Visual design requirements

**Web shell:** brand mark and wordmark, main nav, identity chip ("Guest" + Sign in, or account menu), theme selector, responsive sidebar/topbar, page title and primary action.
**Account-required intro:** one reusable component on all platforms for the Clipboard tab, the Devices account section, and disabled Settings sections: icon, headline, two-sentence benefit, privacy line, Sign in and Create account buttons. It is an informational state, never styled as an error.
**Transfer dashboard:** prominent Send/Receive, active transfer summary, session card, device/network indicators, first-run empty state.
**Send session:** drag-and-drop + picker, file list with icon/name/size/remove, total size, create action, QR/code/copy-link panel, live request list, approval controls, capacity indicator.
**Active transfer:** overall, per-receiver, per-file progress; route badge (Direct / Relay / Cloud); throughput and ETA with uncertainty state; pause/resume/retry/cancel; details/error drawer; restrained completion state.
**Receive page:** sender details, file preview, request access, approval wait, destination/permission guidance, progress and verification.
**Clipboard:** Sync button, capture status with capability explanation, item timeline with device and time, truncated preview, Copy, search/filter, clear history, privacy hints.
**History / Devices / Settings:** usable, coherent screens.
**Android:** all equivalent screens in Compose with state hoisting; long-running work out of composables.
**iOS:** all equivalent screens in SwiftUI with `@Observable` view models, engine work on structured-concurrency tasks off the main actor, Human Interface Guidelines patterns while keeping the Share Anywhere identity.

Microcopy: "Get started", "No account needed to send or receive files", "Guest", "Sign in to sync your clipboard", "Stored on this device only", "Sign in to use Cloud transfer", "Send files", "Receive files", "Waiting for approval", "Connected directly", "Using relay", "Cloud transfer requires your approval", "Sync Clipboard", "Automatic capture is available when your browser permits it", "Open Share Anywhere to sync clipboard", "Your clipboard content is encrypted before sync". Never "Always syncing".

## 10. Accessibility and localization

Keyboard navigation; screen reader labels and landmarks (VoiceOver labels and traits on iOS); focus management in dialogs; no color-only status; touch targets ≥ 48 dp / 44 pt; system font scaling and Dynamic Type; reduced motion; English and Vietnamese catalogs (`web/src/i18n/{en,vi}.json`, Android `values/`, `values-vi/`, iOS `Localizable.xcstrings`); no concatenated fragments; tested breakpoints; QR and code usable on small viewports.

## 11. Security requirements

### 11.1 Controls
Identity and authz per `CLAUDE.md` §7 and PRD §8, plus: rate limits per §8.4; IDOR tests for every resource; WebSocket ticket-authenticated and origin-checked; every route enforces its declared access level (§8.5). Transfer: approval mandatory for every receiver, guest or signed in; verification words on both sides; sender block; validate file metadata server-side; distrust MIME and names; protect signaling; block and file hash verification; prevent unauthorized resume or takeover (resume requires the transfer capability bound to the participant). Clipboard and history: account-only, E2E, no plaintext storage/logging, sensitive flags, no silent remote write, revoke and rotate, retention controls, rate and payload limits. General: input validation, parameterized SQL, CSRF protection on the cookie-carried refresh endpoint, strict CORS, CSP, no unsafe HTML, log redaction, dependency scanning in CI.

### 11.2 Threat model inputs
`docs/SECURITY_MODEL.md` (Phase 1 first version, extended in Phases 2, 5, 8, reviewed in Phase 9) must cover assets, trust boundaries, abuse cases, mitigations, and residual risks, including at least these anonymous-use cases:

| Abuse case | Mitigations | Residual risk |
|---|---|---|
| Mass creation of anonymous devices (Sybil) to bypass per-device limits | IP-keyed creation limit, proof-of-work above soft limit, per-IP limits on every sensitive action in addition to per-device | Large botnets with many IPs; monitored via metrics, CAPTCHA adapter available |
| Enumerating six-digit codes to join strangers' sessions | Code is lookup only; join still needs sender approval; code valid only while accepting receivers; IP and device lookup limits with lockout; failed-lookup alarm | A lucky guess can show a session preview (file names, sender display name); preview exposes nothing else and approval is still required |
| Flooding a sender with join requests | Per-device join limit, 10 pending requests per session, block button, stop-accepting control | Annoyance for the sender until they stop accepting |
| Impersonation through display names ("IT Support") | Guest/Signed in badge, verification words compared out of band, names are self-chosen and labeled as such | Social engineering of inattentive users |
| Using TURN as a free relay or proxy | Credentials only for active sessions with approved participants, short TTL, per-device issue limits, coturn quotas, relay byte caps per session | Abuse within caps by a legitimate-looking pair of devices |
| Hosting abuse via Cloud Distribution | Cloud requires an account, budget cap, TTL, deletion after completion | Abuse by registered accounts; account suspension tooling is backlog |
| Malware distribution through P2P sessions | Server never sees content; explicit approval; file names and sizes shown before accepting; no public session listing | Recipients may still accept malicious files from someone they trust |
| Stolen access token | 15-minute TTL, bound to device, no long-term power | Short window of misuse |
| Stolen refresh secret | Rotation on every use with reuse detection revoking the device; secure storage per platform; `HttpOnly` cookie on Web | Theft followed by use before the legitimate device refreshes |
| CSRF against the Web refresh cookie | `SameSite=Strict`, path-scoped cookie, required custom header, CORS allowlist | — |
| Unauthorized resume or transfer takeover | Transfer capability bound to participant and device; re-handshake on every reconnect | — |
| Linking guest activity to an account | Sign-out issues a new anonymous identity; server session records purged after 7 days | Before purge, the server can correlate pre-sign-in sessions from the same device ID |
| Rate limits hurting users behind CGNAT | Combined IP + device keys, generous IP bursts, clear 429 messaging | Very busy shared IPs may still hit limits |
| Denial of service on signaling | WebSocket per-IP and per-device caps, message rate limits, ticket requirement | Volumetric attacks need upstream protection |

## 12. Observability

No file content or clipboard plaintext in telemetry. IP addresses are used for rate limiting in memory only; logs store a keyed hash of the IP truncated to /24 (IPv4) or /48 (IPv6) with 7-day retention. Guest and account metrics are aggregated, never per person. Metrics: anonymous device creations, proof-of-work challenges issued, 429 counts per limiter, failed code lookups, session create/join/approve counts split by guest vs signed-in sender, route outcomes, completion/failure rates, reconnect/resume success, throughput buckets, TURN bytes, cloud consent and estimates, clipboard event counts and sync latency, browser permission failures by family. No third-party analytics without an explicit decision. Prometheus endpoint `/metrics` on the backend; dashboards are post-MVP.

## 13. Acceptance test matrix

Mapped to CI jobs in `docs/TESTING_AND_CI.md`.

**Guest-first:** first launch goes Welcome → Transfer home with no sign-in screen on Web, Android, and iOS; join link on first visit skips Welcome; guest sender and guest receiver complete a transfer without any account on every client pair; anonymous identity survives reload/restart; refresh rotation and reuse detection; reset device identity; History stored locally for guests and survives restart; Settings shows Guest and Sign in; Clipboard tab shows the intro for guests and makes no clipboard API or permission calls; clipboard, history-sync, devices-list, and keys endpoints return `403 account_required` for guest tokens and `403 device_not_added` for signed-in but not-added devices; Cloud distribute as guest returns `403 cloud_requires_account` and the UI shows the disabled option; guest receiver can download a cloud-distributed file; sign-in during an active transfer does not interrupt it; post-sign-in choices (add device on/off, copy history on/off) behave as specified; sign-out issues a new device ID and wipes ADK material.
**Abuse and rate limits:** anonymous device creation limit and proof-of-work; session creation limit; concurrent open sessions per device; code lookup limits and lockout; join request limit and per-session pending cap; block prevents re-request; TURN credential refused for unapproved or non-active participants and when over limit; WebSocket connection caps; `Retry-After` present and shown in UI; `X-Forwarded-For` ignored from untrusted sources; every route enforces its declared `x-sa-access` level.
**Pairing:** valid QR join; valid code join; expired link; invalid code; rate-limit lockout; approval; rejection; verification words match on both sides; sender closes; session TTLs (waiting, idle, max lifetime); sixth receiver rejected atomically under concurrency.
**Transfer:** Web→Web; Android→Web; Web→Android; iOS→Web; Web→iOS; Android↔iOS (nightly); multiple files; empty/unsupported file; read permission revoked; storage full; sender disconnect; receiver disconnect; pause/resume; out-of-order blocks; missing-block bitmap; checksum mismatch; reconnect and route migration; slow receiver does not stall others; five concurrent receivers; forced TURN relay.
**Clipboard (signed in, device added):** Web manual capture; Web auto best-effort; permission denied; insecure/unsupported context; in-page copy event only; no false universal-observation claim; Android foreground capture; Android background restriction; Android manual action; iOS foreground capture; iOS background non-capture; iOS `UIPasteControl` sync without banner; iOS fallback button path; sensitive skipped; duplicate event idempotency; remote item shown; explicit Copy writes; no auto-overwrite; offline queue and reconnect; expiry and deletion; ciphertext undecryptable without client key; new-device pairing; recovery phrase; revoke and rotate; encrypted cloud history round-trip and import of local history.
**UX:** all states, each in guest and signed-in variants where they differ; keyboard; screen reader labels (TalkBack, VoiceOver); responsive (desktop, Pixel 7, iPhone 14 browser profiles; iPhone SE and iPhone 15 Pro Max simulators); Dynamic Type; dark/light; EN/VI.
