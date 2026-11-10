# ADR 0004: Account Data Key bootstrap

Status: Accepted (Phase 0, 2026-11-10)

## Context

Clipboard items and cloud history are end-to-end encrypted; the server must never be able to read them (PRD §2, §7.5). New devices need the key without the server ever holding it in usable form, and users who lose every device need a way back.

## Decision

- An **Account Data Key (ADK)** is generated on the first device at account creation, versioned with `key_version`, with HKDF subkeys `clipboard-v1` and `history-v1`.
- New devices get the ADK through QR pairing from an existing device (ephemeral X25519, HKDF, wrapped blob for one-time pickup).
- A 12-word recovery phrase, shown once, unwraps a server-stored recovery-wrapped copy (Argon2id on the phrase).
- Revoking a device rotates the ADK; old items stay readable with their old version.
- Platform storage: non-extractable WebCrypto key in IndexedDB on Web, Android Keystore wrapping, iOS Secure Enclave wrapping with Keychain `ThisDeviceOnly`.

## Consequences

- If every device and the recovery phrase are lost, history is unrecoverable, and the UI must say so.
- Implemented in Phase 5A; Phase 5B and the native phases consume the frozen vectors in `shared/protocol/schemas/clipboard-vectors.json`.
