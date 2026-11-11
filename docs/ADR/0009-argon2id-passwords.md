# ADR 0009: Argon2id parameters for account passwords

Status: Accepted (Phase 5A, 2026-11-11)

## Context

PRD §2 fixes Argon2id for account passwords and `docs/SECURITY_MODEL.md` §4 asks for the parameters in an ADR. The backend is a single Go instance in a small container; sign-in bursts must not exhaust memory, and the cost must still make offline guessing of a leaked hash expensive. The recovery phrase uses Argon2id too, but on the client with its own, stronger parameters (`docs/CLIPBOARD_PROTOCOL.md`); this ADR covers only server-side password hashing.

## Decision

- `golang.org/x/crypto/argon2` (`IDKey`, pinned through `golang.org/x/crypto` v0.58.0 in `backend/go.mod`).
- **m = 19,456 KiB (19 MiB), t = 2, p = 1**, 16-byte random salt, 32-byte output: the OWASP Password Storage Cheat Sheet baseline for Argon2id.
- Stored as a PHC string, `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<key>` (unpadded standard base64), so parameters travel with each hash.
- Verification decodes the parameters from the stored hash, compares in constant time (`crypto/subtle`), and flags hashes made with other parameters; a successful sign-in then re-hashes with the current ones.
- At most 4 hashes run at once per instance (about 76 MiB); further requests wait, bounded by the request context.
- An unknown email is verified against a dummy hash made at startup, so both paths cost one Argon2id run and return the same `401 invalid_credentials`.
- Password policy: 10–128 characters, not in a built-in common-password list, not one repeated character, not containing the email's local part.
- `backend/internal/auth/password_test.go` pins these values; changing them needs a new ADR.

## Alternatives

- m = 64 MiB, t = 3: stronger, but four concurrent hashes would need 256 MiB, and sign-in latency on small hosts rises past a second. Revisit with Phase 9 load tests.
- bcrypt or scrypt: the PRD names Argon2id.

## Consequences

- One hash takes tens of milliseconds on a modern core; sign-in rate limits (`docs/SECURITY_MODEL.md` §5) bound the CPU an attacker can spend.
- Raising the cost later is transparent: hashes upgrade on the next successful sign-in.
