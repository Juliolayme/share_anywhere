# ADR 0021: Cryptography for the account keys on Android

Status: Accepted (Phase 6, milestone 6.4, 2026-11-11)

## Context

Clipboard Sync and cloud history on Android must reproduce the account-key protocol of docs/CLIPBOARD_PROTOCOL.md §1 byte for byte (`shared/protocol/schemas/clipboard-vectors.json`): HKDF-SHA256, AES-256-GCM, X25519 (RFC 7748, all-zero results rejected), Ed25519 (RFC 8032, strict verification), Argon2id (m 64–256 MiB, t 3–10, p 1–4) and BIP-39 phrases. minSdk is 26: the platform has AES-GCM, HMAC and SHA-256 at every level, but X25519 and Ed25519 only from later API levels and Argon2id not at all.

## Decision

- **AES-256-GCM, HMAC-SHA256, SHA-256:** the platform JCA.
- **HKDF, X25519, Ed25519, Argon2id:** BouncyCastle **`org.bouncycastle:bcprov-jdk18on` 1.86** (MIT-style licence), using its low-level classes (`rfc7748.X25519`, `rfc8032.Ed25519`, `Argon2BytesGenerator`, `HKDFBytesGenerator`) directly, not through a JCA provider, so the platform's own BouncyCastle copy is never involved.
- **At rest:** every ADK version and the device wrapping key are sealed with AES-256-GCM under a non-exportable **Android Keystore** key (`sa_account_keys_v1`), with AADs that name the item and the account (`adk|<v>|<account>`, `device|x25519|<account>`), in one file in `noBackupFilesDir` (excluded from backup). The file is bound to one account and erased on sign-out, when another account signs in, and when the account session ends (§1.9).
- The BIP-39 English wordlist is a copy of `web/src/lib/crypto/bip39-english.txt`; a unit test fails if the two differ.

## Reasons

- One audited library covers every primitive the platform lacks at API 26, with pure-Java code that runs unchanged in JVM unit tests (the vectors and flow tests run without a device).
- Tink does not provide Argon2id; libsodium bindings would add native code per ABI.

## Consequences

- Raw ADK bytes exist in process memory while wrapping, signing or deriving subkeys and are zeroed afterwards (best effort on the JVM), as on the Web (§1.11). The Keystore key protects them at rest only.
- R8 shrinks the unused parts of BouncyCastle in release builds; debug APKs carry the whole jar (about 8 MB uncompressed).
- Argon2id at 64 MiB runs off the main thread (`Dispatchers.Default`) and takes about a second on a mid-range phone; the phrase screen shows progress text while it runs.
