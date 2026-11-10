# Security Model

Source of truth for identity security, join modes, session lifetimes, rate limits, the threat model, and privacy rules. Product decisions live in `docs/PRODUCT_REQUIREMENTS.md` §2; the API access matrix lives in `docs/API.md`; component and flow diagrams live in `docs/ARCHITECTURE.md`. Phases extend this document (Phase 1 identity, Phase 2 join and sessions, Phase 5A accounts, Phase 5B clipboard, Phase 8 TURN and Cloud) and Phase 9 reviews it end to end.

Status: **planned**. Nothing here is implemented yet; each section names the phase that implements it.

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
| TURN credentials | Participant devices | Lets a device consume relay bandwidth |
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
- **Refresh secret:** 256-bit random, stored hashed, rotated on every refresh. Presenting an already-used secret revokes the device and all its sessions (reuse detection).
- **Web refresh transport:** cookie `sa_device` with `HttpOnly; Secure; SameSite=Strict; Path=/v1/devices/token`, plus a required `X-SA-Refresh: 1` header that cross-site pages cannot send without a CORS preflight the server refuses. Access tokens live in memory only, never in `localStorage` or `sessionStorage`.
- **Native refresh storage:** Android Keystore-backed encrypted storage; iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, excluded from iCloud Keychain and backups.
- **Lifetimes:** anonymous refresh secret expires after 30 days without use; account-added device after 90 days without use; inactive anonymous devices are purged after 30 days.
- **Anonymous bootstrap:** rate-limited per IP; a proof-of-work challenge is required beyond the soft limit. A third-party CAPTCHA is available only through an optional adapter, off by default.
- **Account session:** layered on the device identity. Sign-in keeps the device ID, so active transfers continue. A signed-in device that is not added to the account gets an account session of at most 24 hours. Sign-out removes the device from the account, revokes the account session, wipes local ADK material, and issues a brand-new anonymous identity.
- **WebSocket:** one-time ticket from `POST /v1/ws/ticket`, valid 30 seconds; `Origin` checked on upgrade.
- **Passwords:** Argon2id with parameters recorded in an ADR; no email verification in v1.

## 5. Rate limits and lockouts

Implemented in Phase 1 (framework, device creation), Phase 2 (sessions, codes, joins, TURN, WebSocket), Phase 5A (accounts), Phase 5B (clipboard). Defaults; every value is configuration documented in `.env.example`.

Token buckets keyed as listed. IPv6 is keyed by /64. The client IP comes from `X-Forwarded-For` only when the request arrives from the trusted Caddy proxy. Responses are `429 rate_limited` with `Retry-After`; clients show the wait time. The MVP keeps buckets in process memory on a single backend instance; going multi-instance requires a shared store and an ADR.

| Action | Keys and limits |
|---|---|
| Anonymous device creation | IP: 10 / hour, burst 3; proof-of-work beyond 3 / hour |
| Token refresh | Device: 60 / hour |
| Session creation | Device: 10 / hour; IP: 30 / hour |
| Concurrent open sessions | Guest device: 2; signed-in device: 5 |
| Code lookup | IP: 10 / min; device: 5 / min |
| Create new code | Device: 20 / hour |
| Failed code lookups | IP: 10 / hour → 30-min lockout; device: 5 / 10 min → 30-min lockout; global: protected mode above `CODE_GUESS_ALARM_PER_MIN` (§3.1) |
| Link / QR resolution | IP: 30 / min; device: 10 / min |
| Joins | Device: 10 / min; per session at most 10 pending requests when approval is on |
| TURN credentials | Guest device: 20 / hour; account device: 60 / hour |
| WebSocket | IP: 20 concurrent; device: 3 concurrent; 50 messages / s per socket |
| Sign-in | IP + email: 5 / 15 min; IP: 30 / hour |
| Sign-up | IP: 5 / hour |
| Password reset request | Email: 3 / hour; IP: 10 / hour |
| Clipboard event creation | Device: 120 / min |

## 6. Session and token lifetimes

Implemented in Phase 2.

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
| Join-request flooding when approval is on | Per-device join limit, 10 pending requests per session, Block, Stop accepting | Annoyance until the sender stops accepting |
| Impersonation through display names | Guest / Signed in badge, security words, names labeled as self-chosen | Social engineering of inattentive users |
| TURN as a free relay or proxy | Credentials only for joined participants of active sessions, short TTL, issue limits, coturn quotas, relay byte caps per session | Abuse within caps |
| Hosting abuse via Cloud Distribution | Signed-in sender only, budget cap, TTL, deletion after completion | Abuse by registered accounts; suspension tooling is backlog |
| Malware distribution | Server never sees content; receiver sees names and sizes before tapping Receive; no public session listing | Recipients may accept malicious files from someone they trust |
| Stolen access token | 15-min TTL, device-bound | Short misuse window |
| Stolen refresh secret | Rotation with reuse detection, platform secure storage, `HttpOnly` cookie | Use before the legitimate device refreshes |
| CSRF on the Web refresh cookie | `SameSite=Strict`, path scope, custom header, CORS allowlist | — |
| Unauthorized resume or transfer takeover | Transfer capability bound to participant and device; re-handshake on reconnect | — |
| Linking guest activity to an account | New anonymous identity on sign-out; server session records purged after 7 days | Before purge, the server can correlate pre-sign-in sessions from one device ID |
| Rate limits hurting CGNAT users | Combined IP + device keys, generous IP bursts, clear 429 messages | Very busy shared IPs may hit limits |
| Signaling denial of service | WebSocket caps, message rate limits, ticket requirement | Volumetric attacks need upstream protection |
| Clipboard or history plaintext exposure | E2E encryption with the ADK, no plaintext logs, guests never touch clipboard APIs | Compromised endpoint device |
| Keep-screen-on abuse draining battery | Held only while a join window is open or transfers are active, released on window end, completion, pause, cancel, close, or expiry; user setting | Waiting is capped at 10 minutes per join window |

## 8. Privacy and logging

- No file content, clipboard plaintext, or history plaintext in logs, metrics, or analytics.
- Tokens, refresh secrets, capabilities, codes, emails, and security words are redacted from logs.
- IP addresses are used for rate limiting in memory only; logs keep a keyed hash of the IP truncated to /24 (IPv4) or /48 (IPv6) for 7 days.
- Metrics are aggregates, never per person. No third-party analytics without an ADR.

## 9. Controls checklist

Parameterized SQL only; input validation on every endpoint; strict CORS allowlist; CSP and safe headers on Web; no unsafe HTML rendering; dependency, secret, and image scanning in CI; every route enforces its declared access level (`docs/API.md` §1); IDOR tests for every resource.
