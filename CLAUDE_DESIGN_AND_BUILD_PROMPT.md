# Share Anywhere — Master Design & Build Prompt for Claude

> **Purpose:** Give this complete brief to Claude (preferably Claude Code with access to this repository). Claude must design the full product, implement the working application, test it, document it, and leave the repository in a reproducible state.
>
> **Product name:** Share Anywhere  
> **Repository:** https://github.com/Juliolayme/share_anywhere  
> **Product category:** Cross-platform peer-to-peer file sharing and clipboard synchronization  
> **Primary platforms:** Android app + responsive Web app (PC browsers)  
> **Working language:** English in source code and technical docs; Vietnamese-ready UI (use an i18n structure, with English as the initial default and Vietnamese translations included where practical).

---

# 0. Your role and execution rules

Act as a principal product designer, UX architect, staff-level full-stack engineer, Android engineer, backend engineer, security engineer, QA engineer, and technical writer.

You are responsible for delivering a **working product**, not merely a Figma-like prototype, static mockup, landing page, or collection of disconnected screens.

## Mandatory working rules

1. Inspect the repository before changing anything. Preserve existing work. This repository may initially be empty; do not assume it is.
2. If empty, initialize a clean monorepo. If it contains code, understand and extend its architecture instead of replacing it blindly.
3. Start by producing a concise implementation plan and a repository inventory. Then proceed without waiting for approval unless a truly blocking credential, external service, or product decision is missing.
4. Work in small, coherent phases. Keep the project buildable after each phase.
5. Implement real interactions and real persistence. Do not ship buttons that do nothing, fake progress bars, hard-coded success messages, or placeholder-only flows.
6. If a third-party credential is unavailable, implement a documented adapter/interface and a local development mode. Never fabricate credentials or claim an external integration works when it has not been tested.
7. Do not silently weaken security to make a demo work. Document limitations and choose safe defaults.
8. Use current stable supported dependencies compatible with the target toolchains. Pin versions and commit lockfiles. Explain any version choice that materially affects implementation.
9. Add automated tests for business logic, API behavior, protocol parsing, and critical UI flows.
10. Run formatter, linter, unit tests, and builds that are available in the current environment. Report commands and honest results.
11. Do not claim a platform feature works unless it has been implemented and tested on that platform. Mark untested device/browser behavior explicitly.
12. Never commit secrets, private keys, signing keys, real user data, or production credentials. Provide `.env.example`.
13. Use conventional, descriptive commits. Do not force-push. Do not overwrite unrelated branches.
14. Build accessible responsive UI: keyboard support, semantic controls, clear focus states, adequate contrast, and useful loading/empty/error states.
15. When requirements conflict, prioritize security, data integrity, platform policy, and the explicit decisions in this brief.

## Definition of done

A feature is done only when:
- its UX states are implemented;
- its happy path works end-to-end;
- failure, retry, empty, loading, and permission-denied states are handled;
- the API and data model are documented;
- automated tests cover its critical logic;
- the relevant build/test commands have been run;
- no obvious dead buttons or fake data remain in production paths.

---

# 1. Product vision

Share Anywhere lets people transfer large files between devices and synchronize text clipboard history across their own devices, without requiring every device to be on the same local network.

Core value:
- Share large files across Android and PC Web.
- Use QR code, six-digit pairing code, or share link to join a session.
- Sender explicitly approves every receiver.
- Support one sender to one receiver and one sender to multiple receivers.
- Support up to **five simultaneous receivers per Share Session**.
- Prefer direct peer-to-peer transport; use TURN relay when necessary.
- Cloud Distribution is optional and must never be used without explicit user consent.
- Resume interrupted transfers without retransmitting already verified blocks.
- Clipboard Sync works between Android and Share Anywhere Web using a hybrid permission-aware approach.

The product should feel trustworthy, fast, simple, and technically capable—not like a developer dashboard.

## Explicit product decisions — do not change silently

| Topic | Decision |
|---|---|
| Product | Share Anywhere |
| Platforms in current scope | Android + PC Web |
| PC experience | Browser only; no mandatory desktop agent |
| Android implementation | Native Kotlin |
| Web implementation | React + TypeScript |
| Backend | Go modular monolith for MVP |
| Primary database | PostgreSQL |
| Realtime | WebSocket |
| P2P transport | WebRTC DataChannel |
| TURN | Coturn or compatible TURN service |
| File size target | 4–20 GB |
| Simultaneous receivers | Maximum 5 per session |
| Pairing | QR + six-digit code + HTTPS share link |
| Approval | Sender must approve each receiver |
| Transfer strategy | Auto |
| Route selection | Per receiver, not one route for the entire session |
| Route preference | Direct P2P, then TURN UDP, then TURN TCP/TLS; optional Cloud Distribution only with consent; otherwise queue/retry |
| Cloud Distribution | Optional, never silently enabled |
| Clipboard PC | Share Anywhere Web only |
| Clipboard Web strategy | Both: best-effort automatic capture when permitted + always-available manual Sync action |
| Clipboard Android | Capture while app has legitimate foreground access; manual sync action when needed |
| Clipboard v1 payload | Text only |
| Clipboard encryption | End-to-end encryption; backend must not see plaintext |
| Clipboard remote write | User explicitly taps Copy; do not overwrite system clipboard automatically |
| User model | Account/device-aware architecture; guest-first onboarding may be supported, but cross-device clipboard requires a signed-in account |
| Deployment | Docker Compose friendly; do not introduce Kubernetes or microservices for MVP |

---

# 2. Brand identity and visual direction

Use the selected **Concept 3 — Universal Transfer** as the brand direction.

## Logo concept

The emblem is a modern rounded transfer symbol:
- opposing arrows communicate two-way movement;
- interlocking blue/green forms communicate connection and sharing;
- a subtle orbit/device motif may be used in the full brand lockup;
- the icon must remain recognizable at small app-icon and favicon sizes.

Do not redraw the logo inconsistently in every screen. Create a reusable brand asset component and a proper asset directory. If the actual approved logo image is available in the repository, use it. If not, create a clean original SVG approximation based on this brief and label it as a working vector, not an official supplied source file.

## Brand palette

Use these as the initial brand tokens; maintain contrast and provide semantic colors separately.

- Primary blue: `#0878E8`
- Primary green: `#16C75A`
- Navy: `#102A56`
- White: `#FFFFFF`
- Light background: a cool near-white such as `#F7FAFD`
- Dark surfaces: deep navy/blue-gray, not pure black
- Success/warning/error/info: accessible semantic tokens

Use blue for sending/transfer/navigation and green for receiving/success/connection, but do not rely on color alone to communicate state.

## Design principles

- Modern, minimal, premium, calm, trustworthy.
- Rounded but not childish.
- Strong hierarchy and generous spacing.
- Clear progress visualization for large transfers.
- Avoid excessive gradients, glassmorphism, neon, decorative blobs, or overuse of shadows.
- Design light and dark themes.
- Responsive Web layouts: desktop-first for PC, gracefully adapt to tablet/mobile browser.
- Android should follow modern Material 3 principles while retaining the Share Anywhere identity.
- Use a consistent icon family (Lucide on Web; Material icons or coherent vector assets on Android).
- Include skeletons, empty states, success states, error states, disabled states, confirmation dialogs, and toast/snackbar feedback.

## Design deliverables

Before implementing screens, define:
- design tokens (color, typography, spacing, radii, shadows, borders);
- component inventory;
- navigation map;
- responsive breakpoints;
- form validation patterns;
- state model for every screen;
- accessibility rules.

Implement the design system in code. Avoid one-off CSS values where tokens should be used.

---

# 3. Product information architecture

Create two primary experiences.

## A. Web application

Main navigation:
1. Transfer
2. Clipboard
3. History
4. Devices
5. Settings

Account menu:
- profile;
- security;
- sign out.

Responsive behavior:
- desktop: sidebar or compact top navigation plus primary content;
- smaller screens: compact navigation and stacked panels;
- do not make the Web client depend on a native desktop agent.

## B. Android application

Bottom navigation:
1. Transfer
2. Clipboard
3. History
4. Devices
5. Settings

Use appropriate Android navigation patterns, system back behavior, permission education, foreground services only where genuinely permitted and needed for file transfers, and lifecycle-safe state handling.

---

# 4. Complete screen inventory and UX requirements

Implement all screens below. Include loading, empty, populated, error, offline, and permission-denied states where applicable.

## 4.1 Onboarding and authentication

- Welcome / value proposition.
- Sign in.
- Create account.
- Forgot password / recovery.
- Email verification state if email auth is implemented.
- Guest mode explanation (if implemented).
- Device registration and trust/pairing.
- Privacy and permissions explanation.
- First-run checklist.

Users should understand why an account is needed for cross-device clipboard sync and how file sharing works without exposing unnecessary personal information.

## 4.2 Transfer home

Show two primary actions:
- Send files
- Receive files

Also show:
- recent sessions;
- active transfers;
- connected devices;
- transfer strategy status;
- clear usage/permission guidance.

The screen must not overwhelm new users. Make “Send files” and “Receive” immediately discoverable.

## 4.3 Send files flow

Screens/states:
1. Select files using native Android document picker or Web file picker.
2. Review selection (name, type, size, total size).
3. Create Share Session.
4. Display QR code, six-digit pairing code, and HTTPS share link.
5. Waiting for receivers.
6. Receiver request card with device name, platform, and requested files/session info.
7. Approve or reject receiver.
8. Participant list, maximum five receivers.
9. Per-receiver connection/route status.
10. Transfer dashboard.
11. Completed, partially completed, failed, paused, and cancelled states.
12. Session close/expire confirmation.

Important:
- Sender explicitly approves every receiver.
- A six-digit code is only a session lookup mechanism; it is not an authorization token.
- Share links and QR payloads must contain high-entropy, short-lived capabilities, not merely the six-digit code.
- Expired, revoked, rejected, or closed sessions must not grant access.
- Display remaining receiver slots clearly.
- Support multiple files per session.
- Do not allow the UI to imply that a receiver has access before approval.

## 4.4 Receive files flow

Screens/states:
1. Scan QR.
2. Enter six-digit code.
3. Open share link / web join page.
4. Preview session sender identity and file list before joining.
5. Request access.
6. Waiting for sender approval.
7. Approved / rejected / expired.
8. Choose destination (Android SAF / browser save target).
9. Receiving progress.
10. Pause/resume/retry.
11. Verification progress.
12. Completed / failed / partial.
13. Open, share, or locate received files where platform APIs permit.

Web join behavior:
- If Android app is installed, Android App Links / verified deep links should open it when correctly configured.
- If not installed, show a Web Join Page.
- Do not promise universal background downloads in mobile browsers.
- A browser may not support writing a 20 GB file to disk in every environment; detect and explain capability limits before transfer.

## 4.5 Multi-receiver session dashboard

A Share Session supports up to five simultaneous receivers.

Show:
- session ID and status;
- sender identity/device;
- each participant and approval state;
- each file;
- one transfer card per file-recipient pair;
- per-recipient progress, speed, ETA, route, retry and error;
- session aggregate progress;
- pause/resume/remove actions per receiver;
- stop all / close session.

A slow or disconnected receiver must not block other receivers.

Session state and transfer state are separate:
- Session examples: CREATED, WAITING, APPROVAL, ACTIVE, COMPLETED, PARTIALLY_COMPLETED, CLOSED, EXPIRED, CANCELLED.
- Transfer examples: PENDING, ACCEPTED, CONNECTING, TRANSFERRING, PAUSED, RESUMING, DISCONNECTED, RECONNECTING, COMPLETED, FAILED, CANCELLED.

Enforce max five receivers on the server atomically, not by a client-side count.

## 4.6 Transfer history

- List past sessions and transfers.
- Search and filter by date, device, status, and file name.
- Show direction, total bytes, destination/source, completion result.
- Reopen details.
- Delete history metadata where permitted.
- Distinguish actual transferred bytes from original file size when displaying partial transfers.

## 4.7 Devices

- List account devices.
- Device name, platform, last seen, trust state.
- Rename device.
- Revoke/unlink device.
- Show current device.
- Explain impact of revocation.
- For clipboard keys, device revocation must stop access to future events and initiate appropriate key rotation policy.

## 4.8 Settings

- Account/security.
- Theme: system/light/dark.
- Language: English/Vietnamese structure.
- Notifications.
- Transfer strategy: Auto as default.
- Cloud Distribution: optional and disabled until user consents.
- Data usage/battery preferences where meaningful.
- Clipboard settings.
- Privacy and retention.
- Manage devices.
- About/version/open-source notices.

## 4.9 Clipboard Sync screens

Implement clipboard as a first-class module, separate from File Transfer internals but sharing account auth, device registry, and WebSocket infrastructure.

Web Clipboard screens:
- Clipboard home/history.
- Manual Sync Clipboard action.
- Browser permission/capability status.
- Automatic capture on/off.
- Clipboard item detail/preview.
- Copy item action.
- Search/filter.
- Clear history confirmation.
- Empty/offline/error states.
- Privacy settings.

Android Clipboard screens:
- Clipboard history.
- Foreground capture status.
- Sync Clipboard action.
- Notification action entry point.
- Item detail and Copy action.
- Search/filter.
- Retention settings.
- Sensitive item skipped state.
- Empty/offline/error states.

Clipboard UX must always make it clear whether capture is automatic, best-effort, or requires a user action.

---

# 5. Clipboard Sync: exact technical behavior

## 5.1 Product behavior

PC uses **Share Anywhere Web only**. Do not add a mandatory Desktop Agent, Tauri app, Rust desktop watcher, or native PC helper.

Web strategy is **Both**:
- automatic best-effort capture when the browser allows reading the system clipboard;
- always-available manual Sync Clipboard button as fallback.

Android strategy is Hybrid:
- capture while Share Anywhere is foreground and legitimately allowed to read clipboard;
- manual Sync action opens/focuses the app and reads clipboard only when permitted;
- do not pretend a normal Android app can continuously read clipboard in the background;
- optional IME is out of v1 scope.

For received remote content:
- show the new item in history;
- user taps Copy to write it to the system clipboard;
- do not silently overwrite the system clipboard.

## 5.2 Browser API constraints

Use the Web Clipboard API:
- `navigator.clipboard.readText()`;
- `navigator.clipboard.writeText()`;
- use `read()` only for a later image feature and only where supported.

Requirements:
- production requires HTTPS;
- feature-detect browser support;
- handle permission denial, missing user activation, insecure context, and unsupported browser;
- invoke reads/writes from valid user gestures where required;
- automatic capture is best-effort and must never be described as a universal OS clipboard watcher;
- the page `copy` event only detects copy activity within the Share Anywhere page, not arbitrary apps or tabs;
- do not run aggressive continuous polling;
- use focus/visibility/interaction opportunities for opportunistic checks only when browser policies permit;
- always keep manual Sync available;
- do not repeatedly spam permission prompts;
- show actionable fallback copy such as “Click Sync Clipboard to read the current clipboard.”

Do not claim that a normal website can observe clipboard changes made in arbitrary apps while its tab is inactive.

## 5.3 Android constraints

Use Android ClipboardManager and lifecycle-aware capture:
- foreground Activity only for normal clipboard reads;
- register `OnPrimaryClipChangedListener` while the app is appropriately active;
- remove/unregister listener when app loses foreground or Activity stops;
- handle sensitive clip metadata/flags when present;
- do not use a Foreground Service as a workaround for background clipboard restrictions;
- use WorkManager for deferrable network sync, not for continuous clipboard monitoring;
- show a clear notification action that opens an Activity for a user-driven sync;
- do not promise that notification background code can read the clipboard without foreground/user interaction.

## 5.4 Clipboard protocol and data model

Every clipboard capture is an immutable event with a unique ID. Do not store only one global clipboard value.

Suggested event metadata:
- event_id (UUID);
- user_id;
- origin_device_id;
- event_type (TEXT in v1);
- mime_type;
- ciphertext;
- nonce;
- key_version;
- payload_size;
- created_at;
- expires_at;
- server ordering cursor/sequence.

Use idempotency on event_id. Maintain per-device sync cursor. Handle offline retries without duplicate events. Do not use timestamps alone as a reliable ordering cursor.

PostgreSQL sequence allocation is not equivalent to commit ordering: transactions may commit out of sequence. Design pagination/cursors so a client never advances past an event that it has not actually received. Use a robust committed event cursor or stable pagination strategy.

Suggested APIs:
- POST `/v1/clipboard/events`
- GET `/v1/clipboard/events?cursor=...`
- GET `/v1/clipboard/history`
- DELETE `/v1/clipboard/events/{id}`
- DELETE `/v1/clipboard/history`
- GET `/v1/clipboard/settings`
- PUT `/v1/clipboard/settings`

WebSocket events:
- CLIPBOARD_EVENT_CREATED
- CLIPBOARD_EVENT_DELETED
- CLIPBOARD_HISTORY_CLEARED
- CLIPBOARD_SETTINGS_UPDATED
- DEVICE_CONNECTED
- DEVICE_DISCONNECTED

WebSocket sends event notification/metadata only. Fetch ciphertext over HTTPS.

## 5.5 Clipboard encryption

Backend must not be able to decrypt clipboard content.

Recommended design:
- client-generated account clipboard key;
- per-item AES-256-GCM encryption with unique random nonce;
- versioned key format;
- device-specific wrapping/protection of account key;
- WebCrypto for Web;
- Android Keystore-backed key protection for Android;
- secure new-device pairing/key transfer;
- optional user-controlled recovery key or encrypted backup.

Never put plaintext encryption keys in localStorage, source code, analytics, crash logs, or server logs. IndexedDB may store appropriately wrapped/non-extractable WebCrypto key material, but design and document browser persistence limitations.

If all trusted devices and recovery material are lost, old encrypted history may be unrecoverable. Explain this clearly.

## 5.6 Clipboard safety and defaults

Initial v1 defaults:
- text only;
- maximum item payload: 256 KB (enforce on client and server);
- history cap: 100 items;
- retention: 7 days;
- skip clipboard items marked sensitive where the platform provides such metadata;
- best-effort sensitive-content detection, without claiming perfect detection;
- no plaintext clipboard logs;
- no automatic remote clipboard write;
- no image/file clipboard in v1;
- user can pause sync and clear history.

Be transparent that heuristic detection cannot guarantee that every password, OTP, API token, or secret is identified.

---

# 6. File Transfer: architecture and behavior

## 6.1 High-level architecture

Use a Go modular monolith as the control plane:
- REST API for sessions, participants, files, transfers, devices, account;
- WebSocket for signaling and control events;
- PostgreSQL for durable metadata;
- Redis optional for ephemeral session coordination/cache, not required if the MVP can safely operate without it;
- Coturn for TURN relay;
- React Web client;
- Kotlin Android client.

No microservices or Kubernetes for MVP.

## 6.2 Transfer modes

### Direct P2P
Each receiver has its own WebRTC PeerConnection and DataChannel. Sender uploads a separate stream to each receiver.

### TURN relay
TURN forwards each receiver's stream. TURN does not store the file and does not magically reduce sender upload volume.

### Cloud Distribution
Optional store-and-forward through S3-compatible object storage. Must be explicitly enabled/consented and cost-estimated before use. Client-side encryption should protect uploaded content. Enforce storage TTL, budget cap, and deletion after completion/expiry.

### P2P cascade
Out of scope for v1; do not implement a receiver-seeding mesh unless later explicitly requested.

## 6.3 Automatic route strategy, per receiver

Default route selection mode: Auto.

Initial candidate order:
1. Direct P2P.
2. TURN UDP.
3. TURN TCP/TLS (commonly port 443 where supported).
4. Cloud Distribution only when enabled, user-consented, and within budget cap.
5. Queue/retry if no acceptable route exists.

This is a policy, not a rigid claim that the first route is always fastest. Compare end-to-end ETA, reliability, device/network constraints, and cost.

Each receiver can use a different route in the same session.

## 6.4 Large-file streaming and reliability

Target file size: 4–20 GB.

Requirements:
- never load entire files into memory;
- use streaming/block-based I/O;
- proposed transfer block size 4 MiB, configurable and benchmarked;
- transport frame size initially conservative (e.g. 64 KiB) but validate actual WebRTC message limits and backpressure;
- bounded buffers and per-peer flow control;
- per-receiver ACK and retry state;
- SHA-256 integrity verification;
- receiver ACKs a block only after successful disk write and verification;
- persist receiver's completed-block bitmap locally;
- resume by exchanging missing-block bitmap, not just a last-chunk number;
- handle out-of-order blocks and holes;
- after route migration, create/re-establish connection, authenticate transfer, exchange bitmap and transmit missing blocks;
- a slow receiver must not stall all other receivers.

Suggested initial concurrency is conservative and must be benchmarked, especially for Android devices with 2 GB RAM. Avoid hard-coding concurrency solely by RAM tier.

## 6.5 Route metrics and ETA

Measure at clients:
- candidate pair/route type;
- connection state;
- RTT;
- actual effective transfer throughput;
- packet loss/retransmission indicators where available;
- DataChannel bufferedAmount;
- ACK rate;
- receiver verified/written bytes.

Use rolling windows and smoothing (e.g. EWMA) rather than reacting to noisy single samples. Do not run huge speed tests before a transfer.

ETA:
- use remaining verified bytes / observed effective throughput;
- initial estimate is provisional;
- refine once real transfer samples exist;
- do not show confident ETA during disconnect/route negotiation;
- group ETA should reflect the slowest active receiver and queued work.

Use hysteresis/cooldown to avoid route flapping. Switch only when current path fails or an alternative is materially better for a sustained period.

## 6.6 Cloud cost and consent

Before Cloud Distribution:
- show estimated temporary storage;
- show anticipated receiver egress;
- show duration/retention;
- show estimated cost or “cost unknown” when provider pricing is unavailable;
- ask for explicit consent;
- enforce user budget cap if configured;
- do not silently exceed the cap;
- if budget is exhausted, pause cloud distribution and offer retry/alternative route.

Do not hard-code provider prices as current facts. Make provider pricing configurable and document that the displayed estimate is an estimate.

---

# 7. Backend domain model

Separate session, participant, shared file, and per-recipient transfer entities.

Suggested core tables:
- users/accounts (if auth is in scope);
- devices;
- share_sessions;
- session_participants;
- shared_files;
- transfers;
- session_events;
- clipboard_events;
- clipboard_device_cursors;
- clipboard_settings;
- account/device key metadata as required.

Important constraints:
- atomic enforcement of max five active/pending receiver slots per session;
- unique session/device membership;
- participant must be approved before file access;
- capability token is separate from six-digit pairing code;
- idempotent state transitions;
- server authorization on every resource;
- no trust in client-supplied user_id/device_id without authenticated binding.

Potential API surface:
- POST `/v1/sessions`
- GET `/v1/sessions/{id}`
- POST `/v1/sessions/{id}/close`
- POST `/v1/sessions/{id}/renew`
- POST `/v1/sessions/join`
- POST `/v1/sessions/join-link`
- POST `/v1/participants/{id}/approve`
- POST `/v1/participants/{id}/reject`
- POST `/v1/participants/{id}/leave`
- DELETE `/v1/participants/{id}`
- POST `/v1/sessions/{id}/files`
- GET `/v1/sessions/{id}/files`
- DELETE `/v1/files/{id}`
- POST `/v1/files/{id}/distribute`
- GET `/v1/transfers/{id}`
- POST `/v1/transfers/{id}/pause`
- POST `/v1/transfers/{id}/resume`
- POST `/v1/transfers/{id}/cancel`
- GET `/v1/sessions/{id}/transfers`

You may refine endpoint semantics, but document the final OpenAPI contract and keep clients consistent with it.

---

# 8. Recommended technology choices

Use these as the default architecture unless repository evidence or a tested compatibility issue requires a justified alternative.

## Backend
- Go (current stable release compatible with environment)
- REST API with a clear router/middleware structure
- WebSocket signaling/control
- PostgreSQL
- SQL migrations
- structured logs with redaction
- health/readiness endpoints
- Docker Compose for local dependencies

## Web
- React
- TypeScript strict mode
- Vite
- a consistent component/design system (Tailwind CSS or CSS modules; pick one and avoid mixing styles randomly)
- TanStack Query or equivalent for server state
- a small predictable state manager only where needed
- WebRTC browser APIs
- Web Crypto API for clipboard encryption
- Clipboard API with progressive enhancement
- browser file APIs with graceful capability detection
- IndexedDB/OPFS for resumable metadata/cache where appropriate
- File System Access API only when supported; provide alternatives and explain large-file limitations.

## Android
- Kotlin
- Jetpack Compose
- Coroutines/Flow
- AndroidX lifecycle
- WorkManager for deferrable tasks
- Storage Access Framework for file access
- streaming I/O
- Android Keystore
- lifecycle-aware ClipboardManager use
- appropriate foreground service/notification handling for long-running transfers, following current Android platform requirements.

## Infra
- Docker Compose
- PostgreSQL
- Coturn
- Caddy or Nginx reverse proxy (choose one)
- optional Redis
- optional S3-compatible object storage only for cloud mode
- Prometheus/Grafana later; do not block MVP on observability infrastructure.

## Testing
- Go unit/integration tests
- TypeScript unit/component/e2e tests
- Android unit tests and instrumentation tests where available
- browser tests for supported Clipboard API behavior and denied permissions
- protocol interoperability tests
- file transfer tests with large sparse/test fixtures and checksums
- reconnect/resume tests.

---

# 9. Repository structure target

Adapt if necessary, but aim for a clear monorepo:

```text
share_anywhere/
├── README.md
├── CLAUDE.md
├── .gitignore
├── .env.example
├── docker-compose.yml
├── docs/
│   ├── PRODUCT_REQUIREMENTS.md
│   ├── ARCHITECTURE.md
│   ├── UX_SCREEN_MAP.md
│   ├── DESIGN_SYSTEM.md
│   ├── SECURITY_MODEL.md
│   ├── TRANSFER_PROTOCOL.md
│   ├── CLIPBOARD_PROTOCOL.md
│   ├── API.md
│   ├── ADR/
│   └── runbooks/
├── backend/
│   ├── cmd/
│   ├── internal/
│   │   ├── auth/
│   │   ├── devices/
│   │   ├── sessions/
│   │   ├── participants/
│   │   ├── files/
│   │   ├── transfers/
│   │   ├── signaling/
│   │   ├── clipboard/
│   │   ├── strategy/
│   │   ├── network/
│   │   ├── eta/
│   │   ├── fallback/
│   │   └── cost/
│   ├── migrations/
│   └── tests/
├── web/
│   ├── public/
│   └── src/
│       ├── app/
│       ├── components/
│       ├── features/
│       │   ├── auth/
│       │   ├── transfer/
│       │   ├── clipboard/
│       │   ├── history/
│       │   ├── devices/
│       │   └── settings/
│       ├── hooks/
│       ├── lib/
│       ├── styles/
│       └── test/
├── android/
│   ├── app/
│   ├── gradle/
│   └── README.md
├── shared/
│   └── protocol/
│       ├── openapi.yaml
│       ├── websocket-events.json
│       └── schemas/
├── infra/
│   ├── coturn/
│   ├── reverse-proxy/
│   └── monitoring/
└── scripts/
```

Do not create empty folders just to match this tree. Every committed artifact must have a purpose.

---

# 10. Detailed visual design requirements

Create a cohesive full product UI rather than a landing page only.

## Web design

### Global shell
- brand mark and Share Anywhere wordmark;
- main navigation;
- current account/device status;
- theme selector;
- responsive sidebar/topbar;
- clear page title and primary action.

### Transfer dashboard
- prominent Send Files and Receive actions;
- active transfer summary;
- session card;
- device/network indicators;
- empty state for first-time use.

### Send session
- drag-and-drop area and file picker;
- file list with icon, name, size and remove action;
- total size;
- create session action;
- QR, pairing code and copy-link panel;
- live participant request list;
- approval controls;
- max-five capacity indicator.

### Active transfer
- overall progress;
- per-receiver progress;
- per-file progress;
- route badge (Direct P2P / TURN / Cloud);
- throughput and ETA with uncertainty state;
- pause/resume/retry/cancel;
- details/error drawer;
- completion celebration without excessive animation.

### Receive page
- sender/device details;
- file preview;
- request access;
- approval waiting;
- destination/permission guidance;
- transfer progress and integrity verification.

### Clipboard
- clear Sync Clipboard button;
- automatic capture status with browser capability/permission explanation;
- timeline/list of clipboard items;
- source device and timestamp;
- item preview with truncation;
- Copy action;
- search/filter;
- clear history;
- privacy hints.

### History / Devices / Settings
Implement usable, coherent screens—not static placeholders.

## Android design

- onboarding/auth;
- home transfer dashboard;
- send/select files;
- create session with QR/code/link;
- incoming receiver approvals;
- receive/join session;
- active multi-receiver transfer;
- transfer detail;
- transfer history;
- clipboard home/history;
- clipboard manual sync;
- devices;
- settings;
- permission education;
- offline/error/empty states.

Use Compose reusable components and state hoisting. Keep long-running work out of composables and avoid blocking the main thread.

## UI microcopy

Use plain language. Examples:
- “Send files”
- “Receive files”
- “Waiting for approval”
- “Connected directly”
- “Using relay”
- “Cloud transfer requires your approval”
- “Sync Clipboard”
- “Automatic capture is available when your browser permits it”
- “Open Share Anywhere to sync clipboard”
- “Your clipboard content is encrypted before sync”

Avoid false promises such as “Always syncing” when the platform cannot guarantee it.

---

# 11. Accessibility, localization, and responsive behavior

- Keyboard navigation on Web.
- Screen reader labels and semantic landmarks.
- Focus management for dialogs and menus.
- Do not encode status using color alone.
- Minimum practical touch target sizes on Android.
- Support system font scaling.
- Respect reduced-motion preference.
- Provide English and Vietnamese string catalogs.
- Do not concatenate translated sentences from fragments.
- Responsive Web breakpoints and tested layouts.
- Ensure QR and pairing code are still usable on small viewports.

---

# 12. Security requirements

Treat security as a product feature.

## Authentication and authorization
- Secure password/session handling if password auth is implemented.
- Prefer established authentication patterns over custom cryptography.
- Authenticate WebSocket connections.
- Authorize every session/file/transfer/clipboard operation.
- Bind device identity to authenticated account/session.
- Prevent IDOR and cross-account access.
- Rate-limit login, code lookup, join requests, and pairing attempts.
- Six-digit code is not an authorization secret.
- High-entropy capability tokens must be scoped, expiring, and revocable.

## File transfer security
- Sender approval is mandatory.
- Validate file metadata and limits server-side.
- Do not trust MIME types or file names.
- Protect signaling and transfer authorization.
- Avoid exposing TURN credentials beyond their intended TTL/scope.
- Verify block hashes and final file hash.
- Prevent unauthorized resume or transfer takeover.

## Clipboard security
- E2E encryption.
- No plaintext server-side storage/logging.
- Sensitive flag handling.
- No silent remote clipboard replacement.
- Device revoke and key rotation.
- User-controlled retention/deletion.
- Rate and payload limits.

## General
- Validate inputs.
- Use parameterized SQL.
- CSRF protections where cookie auth requires them.
- Secure CORS policy.
- Content Security Policy and safe headers where applicable.
- Avoid unsafe HTML rendering.
- Redact secrets and personal data from logs.
- Add dependency/security scanning workflow where practical.

Include a threat model documenting assets, trust boundaries, abuse cases, mitigations, and residual risks.

---

# 13. Product analytics and observability

Do not collect file contents or clipboard plaintext in analytics.

Useful operational metrics:
- session creation/join/approval counts;
- route selection outcomes;
- transfer completion/failure rates;
- reconnect/resume success;
- aggregate throughput buckets;
- TURN usage bytes;
- Cloud Distribution consent and cost estimates;
- clipboard event counts and sync latency (metadata only);
- browser permission failures by browser family/version when privacy-safe.

Do not add invasive tracking or third-party analytics without explicit product decision.

---

# 14. Development phases and required deliverables

Work in phases. Keep each phase buildable and documented.

## Phase 0 — Repository assessment and product/design foundation
Deliver:
- repo inventory;
- architecture decision record;
- product requirements;
- screen map;
- design system and tokens;
- implementation roadmap;
- initial README;
- working brand assets.

## Phase 1 — Web shell and backend foundation
Deliver:
- Web app shell and all navigation routes;
- reusable design system;
- responsive layout;
- Go API service;
- PostgreSQL migrations;
- health endpoints;
- local Docker Compose;
- config validation;
- authentication scaffolding or real auth (choose and document).

## Phase 2 — Session pairing and signaling
Deliver:
- session create/join;
- QR/code/link;
- short-lived capability token;
- sender approval/rejection;
- max-five atomic enforcement;
- WebSocket signaling;
- Android/Web join flows.

## Phase 3 — P2P file transfer MVP
Deliver:
- Android ↔ Web text/small-file proof;
- large-file streaming architecture;
- chunking;
- per-peer backpressure;
- checksum;
- pause/resume;
- offline/reconnect handling;
- tests.

Do not claim 20 GB support until a real platform test or a clearly documented test harness verifies the relevant path. Browser and Android lifecycle/file-system limits must be stated honestly.

## Phase 4 — Multi-receiver
Deliver:
- up to five receivers;
- independent transfers;
- per-recipient controls;
- route state per receiver;
- concurrency/scheduler;
- max-five race-condition tests.

## Phase 5 — Clipboard Sync v1
Deliver:
- protocol and migrations;
- E2E encryption/key management;
- Web Clipboard automatic best-effort + manual sync;
- Android foreground capture + manual sync;
- realtime event notification;
- history, search, retention, clear history;
- offline sync;
- sensitive handling;
- permission-denied UX;
- cross-client tests.

## Phase 6 — Route strategy, TURN and optional Cloud
Deliver:
- route probing/measurement;
- direct P2P → TURN fallback;
- TCP/TLS TURN;
- per-receiver route evaluation;
- hysteresis;
- resume across route changes;
- cloud cost estimate;
- explicit Cloud consent;
- budget guard and TTL cleanup.

## Phase 7 — Hardening and release readiness
Deliver:
- security review;
- accessibility pass;
- responsive/browser pass;
- Android lifecycle/device pass;
- failure-injection tests;
- deployment docs;
- backup/restore docs;
- release checklist;
- known limitations.

If time or tool limits prevent all phases in one run, do not fake completion. Finish the current phase to a buildable state, create a clearly prioritized backlog, and report exactly what remains.

---

# 15. Acceptance test matrix

Create automated/manual test cases covering at least:

## Pairing
- valid QR join;
- valid code join;
- expired link;
- invalid code;
- rate-limit lockout;
- receiver approval/rejection;
- sender closes session;
- sixth receiver rejected atomically.

## Transfer
- Android to Web;
- Web to Android;
- multiple files;
- empty/unsupported file;
- file read permission revoked;
- receiver storage full;
- sender disconnect;
- receiver disconnect;
- pause/resume;
- out-of-order blocks;
- missing block bitmap;
- checksum mismatch;
- reconnect and route migration;
- slow receiver does not stall other receiver;
- five concurrent receivers.

## Clipboard
- Web manual capture;
- Web auto best-effort when browser permits;
- browser permission denied;
- unsupported/insecure context;
- page copy event only captures within-page copy;
- clipboard changed in another app is not falsely claimed to be universally observable;
- Android foreground capture;
- Android background restriction;
- Android manual action;
- sensitive item skipped;
- duplicate event idempotency;
- remote item shown in history;
- explicit Copy writes to system clipboard;
- no remote auto-overwrite;
- offline queue and reconnect;
- history expiration and deletion;
- backend ciphertext cannot be decrypted without client key.

## UX
- loading, empty, error, offline, denied, success, partial states;
- keyboard navigation;
- screen reader labels;
- mobile responsive layout;
- dark/light theme;
- Vietnamese/English string selection.

---

# 16. Documentation requirements

Maintain:
- `README.md`: product overview, screenshots, architecture summary, quick start;
- `CLAUDE.md`: repository-specific implementation guidance and coding conventions;
- `docs/PRODUCT_REQUIREMENTS.md`;
- `docs/ARCHITECTURE.md`;
- `docs/UX_SCREEN_MAP.md`;
- `docs/DESIGN_SYSTEM.md`;
- `docs/SECURITY_MODEL.md`;
- `docs/TRANSFER_PROTOCOL.md`;
- `docs/CLIPBOARD_PROTOCOL.md`;
- `docs/API.md` or generated OpenAPI;
- `docs/ADR/`: important architectural choices;
- platform-specific build and test instructions.

Document all external prerequisites:
- TURN server;
- domain and HTTPS;
- Android signing configuration;
- auth/email provider if used;
- optional object storage for Cloud Distribution.

Never put real secret values in docs.

---

# 17. Final response/report format

At the end of your work, provide a concise but specific report:

1. What was implemented.
2. Which screens/routes are usable.
3. Which end-to-end workflows actually work.
4. Repository structure changes.
5. Commands executed and test/build results.
6. Required environment variables and external services.
7. Known limitations and untested platform behaviors.
8. Remaining backlog prioritized P0/P1/P2.
9. Exact local run instructions for macOS.
10. Git commit hashes created.

Do not say “complete” if only design mocks or scaffolding exist. Separate implemented, tested, partially implemented, and planned features.

---

# 18. First actions to take now

1. Inspect repository, branch, and existing files.
2. Report whether it is empty or contains existing work.
3. Establish the design system and screen map.
4. Create the Web app shell and backend foundation.
5. Implement the first real vertical slice: account/device setup → create Share Session → show QR/code/link → receiver join request → sender approval.
6. Add tests and run them.
7. Continue through the phases in order, keeping the repository buildable.

**Do not stop after producing a plan or static UI. Continue implementing the product in this repository, within the capabilities of the current environment.**
