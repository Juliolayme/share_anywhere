# ADR 0010: Account sessions layered on device identity

Status: Accepted (Phase 5A, 2026-11-11); partly superseded by 0013

## Context

PRD §2 makes file sharing guest-first: every installation has an anonymous device identity, and an account only adds Clipboard Sync, the account Devices list, cloud history, and Cloud as a sender. Signing in must not interrupt a running transfer, a signed-in device that is not added gets at most 24 hours, and signing out must leave nothing that links later guest activity to the account. ADR 0002 set the direction; this ADR records how the backend builds it.

## Decision

- **No separate account token.** The device access token (ADR 0008) gains `acct` (user ID) and `dl` (device added) while the device has a live row in `auth_sessions`. There is one such row per device (partial unique index); sign-in on a signed-in device is `409 already_signed_in`.
- **Claims follow the session.** `POST /v1/devices/token` re-derives `acct`/`dl` on every refresh and slides an added device's session. Verification compares the claims of any token carrying `acct` with the live session (cached 30 seconds per instance and dropped on every change), and account handlers re-read the session, so revocation takes effect at once instead of after the 15-minute token lifetime.
- **Lifetimes.** Added device: sliding 90 days, and the device row itself becomes `kind = account` with a 90-day lifetime. Not added: 24 hours from sign-in, never extended, device stays `kind = anonymous`. A periodic sweep ends expired sessions.
- **Leaving the account** (sign-out, revoke from Devices, password reset, password change for other devices, identity reset, refresh-secret reuse, expiry) always does the same thing in one transaction: end the session, set the device back to `kind = anonymous`, and delete its wrapping key, pending key blobs, and pairing.
- **Sign-out** then revokes the device identity and creates a brand-new one with the same platform and refresh transport, answered like `POST /v1/devices/current/reset` (new `sa_device` cookie on the Web, `refresh_secret` in the body for native apps). It is not counted against the device-creation limit because sign-ins are limited.
- **Revoke from Devices** keeps the revoked device's guest identity, so its file sharing continues; only account access ends, and the revoking device rotates the ADK.
- **Module boundary.** `backend/internal/devices` declares an `Accounts` interface that `backend/internal/auth` implements; `cmd/server` wires them, so `devices` never imports `auth`.
- **Web refresh cookie.** The PRD's "browser-session cookie" for not-added devices is not used: the same `sa_device` cookie carries the guest identity, which must survive a browser restart. The 24-hour limit is enforced server-side instead.

## Consequences

- Guests are unaffected: no account check exists on any transfer route, and the only extra cost for guest tokens is none (the account check runs only for tokens carrying `acct`).
- The revocation check is per instance; going multi-instance needs a shared invalidation channel or a shorter cache, recorded with the rate-limit store question (`docs/SECURITY_MODEL.md` §5).
- Sign-in keeps the device ID, so the server can correlate that device's earlier guest sessions with the account until they are purged (7 days); sign-out breaks the link going forward.
