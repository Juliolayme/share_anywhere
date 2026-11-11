# ADR 0011: Grace window for the previous refresh secret

Status: Accepted (Phase 5A, 2026-11-11); partly superseded by 0013

## Context

Refresh secrets rotate on every use, and presenting a used secret revokes the device (`docs/SECURITY_MODEL.md` §4). On the Web the secret travels in the `HttpOnly` `sa_device` cookie. If the user closes or reloads the page after the server has rotated the secret but before the browser stored the response's `Set-Cookie`, the browser still holds the old secret. The next page load presents it, the server sees reuse, revokes the device, and the user silently becomes a new guest; with an account this also ends the account session and loses this device's keys. Phase 5A account e2e runs hit this six times; it is an ordinary user action, not an attack.

## Decision

- A used secret is still accepted when **all** hold: it is the **immediately previous** secret (its generation is the device's current generation minus one), its **first** use was at most **30 seconds** ago (`RefreshReuseGrace`), and the device is active.
- In that case the server **retires the newer secret** (marks it used) and rotates again, so the device never has two live secrets. The previous secret's first-use time is kept, so the window cannot be stretched.
- Everything else is reuse and revokes the device as before: a second grace use of the same secret (the chain has moved two steps), any older secret, a retired secret presented after its window, and any reuse after 30 seconds.
- Both stores (PostgreSQL under the existing row lock, and the in-memory store) apply the same rule; tests cover each case (`backend/internal/devices/service_test.go` `testReuseGrace`, `pgstore_test.go`).

## Consequences

- A lost rotated cookie no longer revokes the device. Concurrent refreshes with the same secret (no Web Locks across tabs) both succeed instead of revoking; only the later secret stays live.
- A thief who copies a secret and uses it within 30 seconds of the legitimate refresh gets a session and retires the legitimate client's secret. The legitimate client's next refresh (normally minutes later) is then reuse, which revokes the device and ends the thief's access too, so detection is delayed by at most the access-token lifetime rather than lost. This is the same trade-off as the "reuse interval" offered by common identity providers.
- Native apps write the secret to secure storage before using the new access token, so they rarely need the window; it applies to them unchanged.
