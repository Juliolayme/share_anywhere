# ADR 0008: Device access token format and lifetimes

Status: Accepted (Phase 1, 2026-11-10)

## Context

Every client request carries a server-signed device access token, guests included (`CLAUDE.md` §7, ADR 0002). `docs/SECURITY_MODEL.md` §4 fixes EdDSA/Ed25519, a 15-minute TTL, and refresh-secret rotation with reuse detection. Phase 1 records the exact format so Web, Android, and iOS can rely on it.

## Decision

**Access token.** A JWS compact JWT signed with Ed25519 (`alg: EdDSA`, the only accepted algorithm) and a `kid` header naming the signing key.

| Claim | Meaning |
|---|---|
| `iss` | `share-anywhere`; any other issuer is rejected |
| `sub` | Device ID (UUID) |
| `typ` | `device`; any other value is rejected |
| `gen` | Refresh generation at issue time |
| `iat`, `exp` | Issued at; expiry 15 minutes later (`exp` is required) |
| `acct`, `dl` | Account ID and "device added to account"; absent for guests, added in Phase 5A |

The server verifies signature, algorithm, issuer, type, and expiry, then checks that the device is still active (not revoked, not expired). That check is cached for 30 seconds per instance and dropped immediately on the instance that revokes; other instances see a revocation within 30 seconds.

**Keys.** `SA_TOKEN_KEYS` holds `kid:base64(32-byte seed)` pairs; `SA_TOKEN_ACTIVE_KID` signs new tokens. Rotation: add the new key, switch the active kid, and remove the old key after 15 minutes. Production refuses to start without keys; development and test generate an ephemeral key.

**Refresh secret.** 32 random bytes, base64url, stored only as SHA-256. Each use rotates it and increments `gen`; presenting a consumed secret revokes the device and deletes all its secrets. The Web gets it as the `sa_device` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/v1/devices/token`, 30-day max age) and must send `X-SA-Refresh: 1` with a cookie refresh; native apps get it in the body (`transport: "body"`) and store it in Keystore or Keychain. The transport is chosen once at creation and stored with the device (`devices.refresh_transport`, migration 0002); refresh and reset always answer in that transport and accept no transport field, so a cookie secret can never be moved into a response body that page scripts could read. (Tightened during Phase 1 QA, before the phase closed.)

**Lifetimes.** Access token 15 minutes. Anonymous device 30 days from its last refresh; each refresh extends it. Revoked devices are purged after 1 day, unused anonymous devices after 30 days (hourly job).

**Bootstrap.** `POST /v1/devices/anonymous` is limited per address (IPv4 or IPv6 /64): above 3 per hour the server answers `428 pow_required` with an HMAC-signed, address-bound, single-use challenge (SHA-256 with `difficulty` leading zero bits, default 16, valid 5 minutes); above 10 per hour it answers `429` with `Retry-After`.

## Consequences

- Clients refresh shortly before `expires_in` runs out and on any `401 device_token_expired`.
- A stolen access token is useful for at most 15 minutes; a stolen refresh secret is detected the first time either party uses it after the other.
- Phase 5A adds `acct` and `dl` without changing the format.
