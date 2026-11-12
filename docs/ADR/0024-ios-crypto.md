# ADR 0024: Cryptography for the account keys on iOS

Status: Accepted (Phase 7, milestone 7.1, 2026-11-12)

## Context

The account-key protocol (`docs/CLIPBOARD_PROTOCOL.md` §1) uses SHA-256, HMAC, HKDF-SHA256, AES-256-GCM, X25519, Ed25519 and Argon2id, byte for byte with the Web and Android and checked by `shared/protocol/schemas/clipboard-vectors.json`. CryptoKit covers everything except Argon2id.

## Decision

- **CryptoKit (through swift-crypto, ADR 0022) for every primitive except Argon2id.** X25519 keys are clamped before use so the public keys match the vectors; an all-zero shared secret is refused (`invalid_key`).
- **Argon2id from the reference implementation, vendored as the C target `CArgon2`** (P-H-C/phc-winner-argon2, tag `20190702`, CC0 or Apache-2.0, unmodified; `ios/ShareAnywhereCore/Sources/CArgon2/VENDORED.md`). It is compiled with `ARGON2_NO_THREADS`; lanes are computed in turn, which gives the same output as parallel lanes. The recovery derivation (m = 64 MiB, t = 3) matches the vector, and a known answer of the reference implementation is checked too.
- **The BIP-39 English wordlist is a resource of `SAClipboardCrypto`**, byte for byte the Web's (a test compares them).
- **Key storage is outside the package**: the app keeps the ADK and device keys in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable), wrapped by a Secure Enclave key where available (milestone 7.4).

## Alternatives considered

- **libsodium (swift-sodium).** Brings a second implementation of primitives CryptoKit already has, and its prebuilt binary does not cover Linux.
- **A Swift Argon2 implementation.** Slower in debug builds and not independently audited; the reference C code is what the other platforms' libraries are checked against.

## Consequences

- Ed25519 signatures made on iOS differ from the deterministic vector bytes (CryptoKit randomizes them); verification is what the protocol relies on, and it is tested both ways.
