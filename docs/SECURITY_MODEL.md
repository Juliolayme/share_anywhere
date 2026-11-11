# Security Model

Source of truth for identity security, join modes, session lifetimes, rate limits, the threat model, and privacy rules. Product decisions live in `docs/PRODUCT_REQUIREMENTS.md` §2; the API access matrix lives in `docs/API.md`; component and flow diagrams live in `docs/ARCHITECTURE.md`. Phases extend this document (Phase 1 identity, Phase 2 join and sessions, Phase 5A accounts, Phase 5B clipboard, Phase 8 TURN and Cloud) and Phase 9 reviews it end to end.

Status: **partly built**. §3, §4 (device identity), §5 (device creation, refresh, sessions, codes, joins, TURN, WebSocket), §6 and §8 are implemented in Phases 1–2; account, clipboard and Cloud rows name the phase that implements them.

---

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| File contents in transit | Sender and receiver devices, WebRTC DataChannel, TURN relay (encrypted DTLS), optional Cloud object store (client-side encrypted) | Primary user data; the server never sees plaintext |
| File names, sizes, counts | Server session records (purged 7 days after the session ends), join preview, local history | Reveal what is being shared |
| Device access token | Client memory | Grants API access as that device for up to 15 minutes |
| Device refresh secret | Web `HttpOnly` cookie, Android Keystore-backed storage, iOS Keychain (`ThisDeviceOnly`) | Mints new access tokens; long-lived |
| Join capability token (link / QR) | Share link, QR code | Admits a receiver while valid |
| Six-digit code | Shown on the sender's screen | Admits a receiver while valid **when approval is off** (§3) |
| Transfer capability | Participant devices | Authorizes resume and re-handshake |
| TURN credentials | Participant devices | Lets a device consume relay bandwidth. **Built in Phase 2** |
| Account credentials | User memory; Argon2id hash on the server | Account takeover |
| Account Data Key (ADK) | Wrapped per device; recovery-wrapped copy on the server | Decrypts clipboard and cloud history |
| Clipboard items, cloud history entries | Server stores ciphertext only | Highly sensitive personal data |
| Rate-limit state, IP addresses | Backend memory; hashed and truncated in logs | Privacy and abuse control |

## 2. Trust boundaries

1. **Client ↔ backend (HTTPS, WebSocket):** the backend trusts only what it can verify from a signed access token, a capability, or a ticket. Client-supplied `user_id` or `device_id` values are ignored.
2. **Client ↔ client (WebRTC):** peers are authenticated by the session (both are participants of the same session, signaling is participant-scoped) and DTLS. The transfer protocol re-authenticates with the transfer capability on every connect and resume.
3. **Client ↔ TURN:** TURN sees encrypted DTLS traffic and time-limited HMAC credentials; it stores nothing.
4. **Client ↔ Cloud object store:** objects are encrypted client-side with a per-file key that travels only over participant-scoped signaling.
5. **Backend ↔ PostgreSQL / coturn / Caddy:** inside the deployment; secrets from configuration; Caddy is the only trusted source of `X-Forwarded-For`.
6. **Guest ↔ account:** account features require the `acct` claim and, for keys, clipboard, and history, a device added to the account.

## 3. Join modes

Every Share Session has a `require_approval` setting.

| | Open join (default, `require_approval = false`) | Approval required (opt-in) |
|---|---|---|
| Who gets in | Anyone holding a valid code, link, or QR, up to 5 receivers | Same, but each receiver waits until the sender approves |
| Receiver state on join | `JOINED` immediately; transfer starts | `REQUESTED` → `JOINED` on approval |
| What the code is | A short-lived **access secret** | A lookup key; approval is the authorization |
| Sender controls | Remove, Block, Stop accepting, Create new code, turn on Require approval, Close | Approve, Reject, Block, Remove, Stop accepting, Create new code, Close |
| Recommended for | Sharing with people in the same room or on a call | Sensitive files, sharing a code in a public place |

The sender can turn Require approval on or off at any time during the session. The change applies to future joins only; people already joined stay joined.

**Status:** sections 3.0–3.1 are built in Phase 2 (`backend/internal/sharing`) and covered by PostgreSQL integration tests (`sharing_test.go`) and the Playwright pairing specs. Protected mode is an in-memory breaker on the single backend instance; the threshold is `SA_CODE_GUESS_ALARM_PER_MIN`.

### 3.0 Join window

- The six-digit code, the share link, and the QR code are issued together and share one **join window of at most 10 minutes**. Inside the window, a valid code, link, or QR lets a receiver join. When the window ends, nobody else can join with them.
- The window ends at whichever comes first: 10 minutes after it opened; the fifth receiver joining (or being requested, when approval applies); or the sender tapping **Stop accepting**.
- **Create new code** (renew) issues a brand-new code, link token, and QR, opens a fresh 10-minute window, and immediately invalidates the previous code, link, and QR. It works whether the old window is still open or has ended, and it is unavailable while 5 receivers are in the session.
- The window controls **only joining**. Receivers who already joined keep transferring normally after it ends; the session itself follows its own lifetime (24 h guest sender, 72 h signed-in sender, §6).
- Requests made inside the window when approval applies stay approvable after it ends.
- A join ticket from a code or link lookup can never outlive the window: a receiver who resolved the code at 9:58 must tap Receive before 10:00.

### 3.1 Protections that make open join acceptable

- **Short join window:** at most 10 minutes per code, link, and QR, ending early when the session is full or the sender stops accepting (§3.0). There is no rotation inside the window and no automatic extension; only the sender can open a new window.
- **Bounded exposure:** a session's code exists only while its window is open, so exposure is 10 minutes per window regardless of how long the session lasts. The previous design rotated the code every 5 minutes but kept *some* valid code for as long as the session accepted receivers, which could be hours.
- **Lockout on guessing:** per-IP and per-device failed-lookup limits with 30-minute lockouts (§5).
- **Protected mode (global circuit breaker):** when failed code lookups across the whole service exceed `CODE_GUESS_ALARM_PER_MIN` (default 300), the service enters protected mode for 30 minutes. In protected mode, every join **made with a six-digit code** lands in `REQUESTED` and needs the sender's approval, even in open-join sessions. Joins through a link or QR are unaffected because their token is high-entropy. Both sides see why ("Extra check: the sender needs to let you in").
- **Five-receiver cap**, enforced atomically in the database.
- **Security words:** three words derived from the session and the receiver device (one English 2048-word list on every platform and language, about 33 bits) appear next to each receiver on the sender's list and on the receiver's screen, so the sender can spot an unexpected device and remove it.
- **Visible joins:** every join shows a toast on the sender's screen and, when the sender's app is in the background, a local notification (`product.peer_joined_receiving`, "{name} joined and is receiving your files").
- **Block:** removes the receiver, revokes its capabilities, and refuses rejoin from that device ID and from its IP /64 for the rest of the session.
- **Link and QR tokens** carry at least 128 bits of entropy, are hashed at rest, expire with the join window (at most 10 minutes), and are replaced by Create new code.
- **Nudges:** after the first join the sender sees "Everyone here? Stop accepting new receivers". The Send review screen shows a hint to turn on Require approval for sensitive files.

### 3.2 Residual risk of open join

A distributed attacker with many IP addresses can still guess a live code before protected mode trips. A successful guess admits the attacker as a receiver, and files may start flowing before the sender notices and removes them. This is the accepted trade-off for zero-friction sharing; the mitigation for sensitive content is Require approval or sharing by link/QR only.

**Model.** The code space has 10^6 values and an attacker never repeats a guess. `N` is the number of join windows open at a moment. Guessing faster than `CODE_GUESS_ALARM_PER_MIN` (default 300 failed lookups per minute, service-wide) turns on protected mode, after which code joins wait for the sender and a correct guess no longer admits anyone. Per-IP limits allow at most about 10 failed guesses per hour per address (§5), so guessing at the ceiling of 300 per minute needs about 1,800 IP addresses. The alarm also counts honest typos, so the real headroom is smaller than these figures.

| Question | Formula | Default values | Result |
|---|---|---|---|
| Chance one guess hits any open window | `N / 10^6` | `N` = 1,000 | 0.1 % |
| Guesses an attacker can make during one 10-minute window without tripping protected mode | `300 × 10` | | 3,000 |
| Chance a **specific** session's code is guessed during one window | `3,000 / 10^6` | | ≤ 0.3 % per window; each Create new code adds up to another 0.3 % |
| Expected successful guesses across the service at the alarm ceiling | `300 × N / 10^6` per minute | `N` = 1,000 (about 100 new sessions per minute) | about 0.3 per minute, about 18 per hour |
| Same, for an attacker with one IP address | `≈ 10 guesses per hour` | | about 1.7 guesses per window; ≤ 0.0002 % per session per window |

Compared with the previous rotation design, the per-guess chance is the same for the same `N`, but each session's exposure is now capped at 10 minutes per window instead of lasting as long as the session accepted receivers, and `N` itself is smaller because codes no longer stay alive during long sessions. Phase 9 measures the real guess rate under the soak test and tunes `CODE_GUESS_ALARM_PER_MIN` and the per-IP limits.

## 4. Identity and tokens

Implemented in Phase 1 (device identity) and Phase 5A (accounts). Flow diagrams in `docs/ARCHITECTURE.md` §3.

- **Access token:** JWT, `alg: EdDSA` (Ed25519) only, any other `alg` rejected; 15-minute TTL; claims `sub` (device ID), `typ: device`, `gen` (refresh generation), `acct` (user ID, only with an account session), `dl` (device added to that account), `kid`. Signing keys come from configuration and rotate via `kid`.
- **Refresh secret:** 256-bit random, stored hashed, rotated on every refresh. Presenting an already-used secret revokes the device and all its sessions (reuse detection). One exception (Phase 5A): the immediately previous secret is accepted once within 30 seconds of its first use, for a rotated cookie lost when a page closed mid-refresh; the newer secret is then retired so only one secret is ever live (`docs/ADR/0011-refresh-reuse-grace.md`).
- **Web refresh transport:** fixed per device at creation (refresh and reset never switch a cookie device to a body response; JSON endpoints accept only `Content-Type: application/json`, which blocks cross-site form posts). Cookie `sa_device` with `HttpOnly; Secure; SameSite=Strict; Path=/v1/devices/token`, plus a required `X-SA-Refresh: 1` header that cross-site pages cannot send without a CORS preflight the server refuses. Access tokens live in memory only, never in `localStorage` or `sessionStorage`.
- **Native refresh storage:** Android Keystore-backed encrypted storage; iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, excluded from iCloud Keychain and backups.
- **Lifetimes:** anonymous refresh secret expires after 30 days without use; account-added device after 90 days without use; inactive anonymous devices are purged after 30 days.
- **Anonymous bootstrap:** rate-limited per IP; a proof-of-work challenge is required beyond the soft limit. A third-party CAPTCHA is available only through an optional adapter, off by default. **As built (Phase 1):** the challenge is an HMAC-signed token bound to the caller's address key, valid 5 minutes and accepted once; the client must find a solution so SHA-256(`token:solution`) has `SA_POW_DIFFICULTY` leading zero bits (default 16). The CAPTCHA adapter is not built (backlog).
- **Verification (Phase 1):** the server accepts only `alg: EdDSA` with a configured `kid`, issuer `share-anywhere`, `typ: device`, and a present `exp`; then it checks the device is active (cached 30 seconds per instance). Tests cover HS256 confusion with the public key, `alg: none`, unknown and removed `kid`, another key, wrong issuer and type, missing `exp`, tampered claims, and expiry (`backend/internal/devices/tokens_test.go`). Format and rotation: `docs/ADR/0008-device-token-format.md`.
- **Account session:** layered on the device identity. Sign-in keeps the device ID, so active transfers continue. A signed-in device that is not added to the account gets an account session of at most 24 hours. Sign-out removes the device from the account, revokes the account session, wipes local ADK material, and issues a brand-new anonymous identity.
- **WebSocket:** one-time ticket from `POST /v1/ws/ticket`, valid 30 seconds; `Origin` checked on upgrade.
- **Passwords:** Argon2id with parameters recorded in an ADR; no email verification in v1.
- **As built (Phase 5A, accounts):** `backend/internal/auth`; session model in `docs/ADR/0010-account-sessions.md`.
  - *Account session.* One `auth_sessions` row per device at a time (partial unique index). Added device: sliding, 90 days from last use (each refresh slides it and the device's own lifetime, now 90 days for `kind = account`). Not-added device: ends 24 hours after sign-in, never extended; the device stays `kind = anonymous`. A background sweep (every 5 minutes) ends expired sessions. Sign-out, revoke, password reset, password change (other devices), identity reset, and refresh-secret reuse all end the session in the same way: the device leaves the account (`kind = anonymous`, `user_id` cleared, lifetime back to 30 days) and its wrapping key, pending key blobs, and pairing are deleted.
  - *Claims stay honest.* Every refresh re-derives `acct` and `dl` from the live session. Verification also compares the claims of any token carrying `acct` with the live session (cached 30 seconds per instance and dropped at once on every change on that instance), and every account handler re-reads the session, so a revoked or signed-out device loses account access immediately, not when its token expires. A token claiming `dl = true` for a not-added session is refused.
  - *Passwords.* Argon2id m = 19,456 KiB, t = 2, p = 1, 16-byte salt, 32-byte key, PHC string format (`docs/ADR/0009-argon2id-passwords.md`); at most 4 hashes run at once per instance; hashes with older parameters are upgraded on the next sign-in. Policy: 10–128 characters, not in a common-password list, not one repeated character, not containing the email's local part. Comparison is constant time. An unknown email verifies against a dummy hash and gets the same `401 invalid_credentials` body.
  - *Password reset.* 256-bit token, SHA-256 at rest, 30 minutes, single use; a successful reset or password change invalidates every outstanding token and ends every account session (a password change keeps the current device). The request always answers `202`; lookup and mail run in the background so the response and its timing do not reveal whether the account exists. Mail goes through an adapter (`SA_MAIL_SINK`): `console` logs the link only with `SA_ENV=development` and never logs the address; `smtp` (mailpit in development; a relay in production, untested); `memory` only with `SA_ENV=test`, read by end-to-end specs through the `testhooks` build.
  - *Sign-out* revokes the device identity and issues a brand-new one with the same platform and refresh transport (§7, guest-to-account linkability).
  - *Account keys and history* are opaque to the server (§7): it stores X25519 public keys, the recovery salt and Argon2id parameters, wrapped ADK blobs, chain blobs, and AES-256-GCM ciphertext, checks only sizes and versions, and cannot decrypt any of them. Pairing codes are 128-bit, SHA-256 at rest, 10 minutes, one per device, picked up once, then the wrapped blob is deleted; request logs redact the code from the path.

## 5. Rate limits and lockouts

Implemented in Phase 1 (framework, device creation), Phase 2 (sessions, codes, joins, TURN, WebSocket), Phase 3 (transfer reports), Phase 5A (accounts), Phase 5B (clipboard). Defaults. In Phase 1 the values are constants in code (`backend/internal/devices/service.go`, `backend/internal/platform/ws`); test stacks scale them with `SA_RATE_LIMIT_MULTIPLIER` (`.env.example`). Making individual limits configurable is backlog.

Token buckets keyed as listed. IPv6 is keyed by /64. The client IP comes from `X-Forwarded-For` only when the request arrives from the trusted Caddy proxy (**as built:** `SA_TRUSTED_PROXIES` lists the trusted peers; the resolver walks `X-Forwarded-For` from the right and stops at the first untrusted address, `backend/internal/platform/clientip`). Automated test stacks may raise every limit with `SA_RATE_LIMIT_MULTIPLIER`, which the backend accepts only with `SA_ENV=test`; it never switches a limit off. Responses are `429 rate_limited` with `Retry-After`; clients show the wait time. The MVP keeps buckets in process memory on a single backend instance; going multi-instance requires a shared store and an ADR.

| Action | Keys and limits |
|---|---|
| Anonymous device creation | Address (IPv4, or IPv6 /64): proof-of-work required beyond 3 / hour (soft limit); `429` beyond 10 / hour (hard limit, attempts that got `428` count). Reset device identity shares the hard limit. Proof-of-work challenges: 30 / min per address. **Built in Phase 1** |
| Token refresh | Device: 60 / hour. **Built in Phase 1** |
| Session creation | Device: 10 / hour; IP: 30 / hour. **Built in Phase 2** |
| Concurrent open sessions | Guest device: 2; signed-in device: 5, counted per device in the same transaction as creation (`409 too_many_open_sessions`). **Built in Phase 2.** Since Phase 4 `GET /v1/sessions` lists the device's open sessions, and the Web send screen shows them with Open and Close when creation hits the cap |
| Code lookup | IP: 10 / min; device: 5 / min. **Built in Phase 2** |
| Create new code | Device: 20 / hour. **Built in Phase 2** |
| Failed code lookups | IP: 10 / hour → 30-min lockout; device: 5 / 10 min → 30-min lockout; global: protected mode above `CODE_GUESS_ALARM_PER_MIN` (§3.1). **Built in Phase 2** |
| Link / QR resolution | IP: 30 / min; device: 10 / min. **Built in Phase 2** |
| Joins | Device: 10 / min; IP: 30 / min. Pending requests count toward the five receiver slots, so at most 5 people can be waiting. **Built in Phase 2** |
| TURN credentials | Guest device: 20 / hour; account device: 60 / hour; IP: 120 / hour. **Built in Phase 2** |
| Transfer reports | Device: 300 / min (clients throttle progress reports to one every 2 s per transfer plus state changes). **Built in Phase 3** |
| WebSocket | IP: 20 concurrent; device: 3 concurrent; 50 messages / s per socket; tickets: 30 / min per device. **Built in Phase 1** |
| Sign-in | IP + email: 5 / 15 min; IP: 30 / hour; device: 10 / 15 min (every attempt). Email from any address: 20 failed attempts / hour, checked before the password is verified. **Built in Phase 5A** (`backend/internal/auth/auth.go`) |
| Sign-up | IP: 5 / hour; device: 3 / hour. **Built in Phase 5A** |
| Password reset request | Email: 3 / hour; IP: 10 / hour. **Built in Phase 5A** |
| Password change | Account: 5 failed current-password checks / 15 min. **Built in Phase 5A** |
| Device pairing | Create: device 10 / hour; code lookup: device 30 / 10 min; IP (create and lookup): 60 / 10 min. **Built in Phase 5A** |
| History writes | Device: 600 / min (entry creation, deletion, clear). **Built in Phase 5A** |
| Clipboard event creation | Device: 120 / min |

## 6. Session and token lifetimes

Implemented in Phase 2 (`backend/internal/sharing/model.go`, `jobs.go`; tests drive them with an injected clock).

| Item | Lifetime |
|---|---|
| Join window: six-digit code, link token, QR | At most 10 min from issue; ends early when 5 receivers are in or the sender taps Stop accepting; Create new code opens a fresh 10-min window and invalidates the old code, link, and QR |
| Join ticket from a code or link lookup | 5 min, single use, never past the end of the join window |
| Joined receivers after the window ends | Unaffected; they continue until the session ends |
| Session idle (no connected participant) | Expires after 30 min |
| Maximum session lifetime | Guest sender 24 h; signed-in sender 72 h |
| Transfer capability | Bound to participant and device; valid until the session ends or the participant is removed |
| TURN credential | Guest 30 min; account 60 min (`docs/ARCHITECTURE.md` §6) |
| Server session records, including file names | Purged 7 days after the session ends |
| Account session, added device | 90 days after last use (sliding); the device itself also lives 90 days without use. **Built in Phase 5A** |
| Account session, signed in but not added | 24 h after sign-in, never extended. **Built in Phase 5A** |
| Password-reset link | 30 min, single use. **Built in Phase 5A** |
| Device pairing code and wrapped blob | 10 min; the blob is deleted at pickup. **Built in Phase 5A** |
| Protected mode | 30 min after the alarm condition clears |

## 7. Threat model

| Abuse case | Mitigations | Residual risk |
|---|---|---|
| Guessing a six-digit code to receive a stranger's files (open join) | 10-min join window per code, window ends when full or not accepting, IP and device lockouts, global protected mode forcing approval for code joins, 5-receiver cap, security words, join toasts and notifications, Remove and Block | Distributed guessing can succeed before protected mode trips (§3.2); senders of sensitive files should turn on Require approval |
| Guessing a code to read the join preview | Same limits; preview shows only sender display name, badge, file names, sizes, count | File names leak to a lucky guesser |
| Shoulder-surfing or overhearing a code | 10-min join window, Stop accepting nudge, security words, Remove/Block, Require approval option | Someone nearby can join within the remaining window |
| Leaked share link or QR photo | Expires with the 10-min join window, replaced by Create new code, Stop accepting, 5-receiver cap | Anyone with the link inside the window can join an open session |
| Removed or blocked receiver keeps receiving | Capabilities revoked, sender closes the peer connection, block covers device ID and IP /64, transfer protocol re-authenticates on every reconnect | TURN allocation stays valid until its credential expires but carries no new data |
| Block evasion by resetting device identity | Block also covers IP /64 for the session; device creation is rate-limited | Attacker with many IPs |
| Mass creation of anonymous devices (Sybil) | IP-keyed creation limit, proof-of-work, IP keys on every sensitive limit | Large botnets; CAPTCHA adapter available |
| Join-request flooding when approval is on | Per-device and per-IP join limits, pending requests count toward the 5 slots, Block, Stop accepting | Annoyance until the sender stops accepting |
| Impersonation through display names | Guest / Signed in badge, security words, names labeled as self-chosen | Social engineering of inattentive users |
| TURN as a free relay or proxy | Credentials only for joined participants of active sessions, short TTL, issue limits, coturn quotas, relay byte caps per session | Abuse within caps |
| Hosting abuse via Cloud Distribution | Signed-in sender only, budget cap, TTL, deletion after completion | Abuse by registered accounts; suspension tooling is backlog |
| Malware distribution | Server never sees content; receiver sees names and sizes before tapping Receive; no public session listing | Recipients may accept malicious files from someone they trust |
| Stolen access token | 15-min TTL, device-bound; account claims are checked against the live account session on every request, so sign-out or revoke ends account access at once | Short misuse window for guest-level actions |
| Stolen refresh secret | Rotation with reuse detection, platform secure storage, `HttpOnly` cookie. With an account (Phase 5A): reuse detection also ends the account session; the owner can revoke the device from Devices on another added device, which ends its account session at once and triggers an ADK rotation, so the thief never receives later keys; Change password ends every other device's session | Use before the legitimate device refreshes, or within the 30-second reuse grace window (ADR 0011), until the legitimate device's next refresh revokes the device; on an added device the thief can read history and keys until revoked |
| Account takeover by password guessing or credential stuffing (Phase 5A) | Argon2id, password policy with a common-password list, sign-in limits per IP + email, IP, device, and failed attempts per email from any address; identical answer and work for unknown emails | Distributed stuffing below the per-email failure limit; an attacker can keep a victim's sign-in rate-limited (at most about one attempt every 3 minutes after 20 failures); no second factor in v1 |
| Account takeover through password reset (Phase 5A) | 256-bit single-use link valid 30 minutes, hashed at rest, request limits per email and IP, no enumeration (always `202`, background processing); a reset ends every account session | Anyone who controls the mailbox controls the account (no email verification in v1). A reset does not reveal keys: history stays encrypted under the ADK, which only added devices and the recovery phrase can unwrap |
| Account enumeration (Phase 5A) | Sign-in and reset never reveal whether an email exists | Sign-up answers `409 email_taken` (product need), limited to 5 per hour per IP and 3 per device |
| A signed-in device that was never added (shared computer) | Account session ends after 24 h; no keys, history, or clipboard (`403 device_not_added`) | It sees the account's email and Devices list until then |
| CSRF on the Web refresh cookie | `SameSite=Strict`, path scope, custom header, CORS allowlist | — |
| Unauthorized resume or transfer takeover | Transfer capability (256-bit HMAC of participant, device and join time, `backend/internal/sharing/member.go`) shown only to that JOINED receiver; the sender gets only its SHA-256 and checks it in HELLO on every connect (`docs/TRANSFER_PROTOCOL.md`); Remove, Block, Leave and rejoin invalidate it; resuming over REST needs it | — |
| Linking guest activity to an account | New anonymous identity on sign-out (Phase 5A: the old device is revoked and the new one shares no ID, secret, or name with it); server session records purged after 7 days | Sign-in keeps the device ID (so running transfers continue), so the server can correlate the device's guest sessions before sign-in with the account until those records are purged; the IP address of the sign-out request also links the two identities in rate-limit memory |
| Rate limits hurting CGNAT users | Combined IP + device keys, generous IP bursts, clear 429 messages | Very busy shared IPs may hit limits |
| Signaling denial of service | WebSocket caps, message rate limits, ticket requirement | Volumetric attacks need upstream protection |
| Clipboard or history plaintext exposure | E2E encryption with the ADK, no plaintext logs, guests never touch clipboard APIs. History (Phase 5A): AES-256-GCM under the `history-v1` subkey with the entry ID and key version as AAD; the server stores ciphertext, nonce, key version, origin device, and timestamps; deletions become tombstones that drop nonce and ciphertext; a revoked device's session ends at once and the next ADK version is wrapped only for remaining devices | Compromised endpoint device; the server learns entry counts, sizes, timing, and which device wrote each entry; a revoked device keeps whatever it already decrypted and old ADK versions |
| Malicious server substituting wrapping keys (Phase 5A) | Keys and blobs are bound to purposes and versions by AAD (`docs/CLIPBOARD_PROTOCOL.md`); pairing needs a code shown on the new device | The server lists device public keys, so a malicious server could add its own key to a rotation list; detecting that needs key fingerprints in the UI (backlog) |
| Keep-screen-on abuse draining battery | Held only while a join window is open or transfers are active, released on window end, completion, pause, cancel, close, or expiry; user setting | Waiting is capped at 10 minutes per join window |

## 8. Privacy and logging

- No file content, clipboard plaintext, or history plaintext in logs, metrics, or analytics.
- Tokens, refresh secrets, capabilities, codes, emails, and security words are redacted from logs.
- IP addresses are used for rate limiting in memory only (participants and blocks store a keyed hash of the IPv4 address or IPv6 /64 so a Block can match it, never the address; both are purged with the session); logs keep a keyed hash of the IP truncated to /24 (IPv4) or /48 (IPv6) for 7 days. **As built (Phase 1):** request logs carry `ip_hash` (HMAC-SHA-256 with `SA_SERVER_SECRET`, first 8 bytes) and never the address or the query string; the log redactor also drops token, secret, cookie, authorization, and security-word fields. Log retention is set by the deployment (Phase 9).
- Metrics are aggregates, never per person. No third-party analytics without an ADR.

## 9. Controls checklist

Parameterized SQL only; input validation on every endpoint; strict CORS allowlist; CSP and safe headers on Web; no unsafe HTML rendering; dependency, secret, and image scanning in CI; every route enforces its declared access level (`docs/API.md` §1); IDOR tests for every resource.
