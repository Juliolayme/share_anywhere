# ADR 0013: Account session hardening (browser-session binding, retired refresh secrets)

Status: Accepted (Phase 5A QA round 1, 2026-11-11)

## Context

Phase 5A QA round 1 found two weaknesses in the session model of ADR 0010 and ADR 0011.

- **P1-1.** PRD §2 says a signed-in device that is not added gets at most 24 hours and, on the Web, a browser-session cookie. ADR 0010 dropped the browser-session cookie because the `sa_device` cookie carries the guest identity, which must survive a browser restart. As built, a not-added Web session on a shared computer survived closing the browser for up to 24 hours: the next person who opened the site was still signed in to the account.
- **P2-1.** ADR 0011's grace path retires the newer secret by marking it used. A retired secret presented inside the 30-second window still matched the grace rule (generation one behind, first used moments ago), so it was accepted, retiring the live secret in turn.

## Decision

- **Browser-session binding for not-added Web sessions.** On sign-in or sign-up with `add_device = false` from a cookie-transport device, the server sets a second cookie, `sa_acct`: 256 random bits, `HttpOnly; SameSite=Strict; Path=/v1/devices/token`, `Secure` per `SA_COOKIE_SECURE`, and no `Max-Age` or `Expires`, so the browser drops it at the end of its session. The server stores its SHA-256 on the account session (`auth_sessions.browser_binding`, migration 0007).
- **Refresh checks it.** `POST /v1/devices/token` passes the presented `sa_acct` (or nothing) to the account layer through the `devices.Accounts` interface (`Refreshed(device, browserBinding)`), so `devices` still never imports `auth`. If the live session is not added and has a binding that does not match (constant-time compare), the account session ends on the same path as expiry (the device leaves the account) and the response is a guest token; the `sa_device` identity is kept.
- **Clearing.** `POST /v1/devices/current/add` drops the binding and expires `sa_acct`; sign-out, identity reset, an added Web sign-in, and a refresh whose account session ended also expire it. Sessions that end elsewhere (revoke from another device, password reset) leave a stale cookie that the next refresh expires.
- **Native apps** (body transport) get no binding; their not-added session keeps the 24-hour limit only, since an app has no browser session.
- **Retired secrets never qualify for grace.** `device_refresh_secrets.retired` (migration 0007, default false) is set on the secret the grace path retires, and the grace rule rejects retired rows, so presenting a retired secret is always reuse and revokes the device. The in-memory store mirrors the flag.
- **Not-added sessions are read-only.** `PATCH /v1/me` and `PATCH /v1/devices/{id}` become `account+device` (QA P2-3).

## Consequences

- Closing the browser ends a not-added Web session at the next page load; Add this device is the way to stay signed in. Browsers that restore session cookies after a restart ("continue where you left off") keep `sa_acct`, so the 24-hour limit stays the backstop there (`docs/SECURITY_MODEL.md` §7).
- A copied `sa_device` cookie alone no longer carries a not-added account session to another browser.
- A refresh that ends the session returns `200` with a guest token rather than an error, so clients follow the existing "claims lost `acct`" path.
- The grace window still recovers a lost rotated cookie exactly once; any further attempt with either of the two old secrets revokes the device.
- Supersedes the "Web refresh cookie" bullet of ADR 0010 and the retired-secret wording of ADR 0011 (a retired secret is reuse at any time, not only after its window).
