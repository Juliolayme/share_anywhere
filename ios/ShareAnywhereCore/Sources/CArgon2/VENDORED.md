# Vendored: Argon2 reference implementation

- Source: <https://github.com/P-H-C/phc-winner-argon2>, tag `20190702` (commit 62358ba2123abd17fccf2a108a301d4b52c01a7c).
- License: CC0 1.0 or Apache License 2.0, at your option (`LICENSE`).
- Files: `src/argon2.c`, `core.c/h`, `encoding.c/h`, `ref.c` (portable reference fill), `thread.c/h`, `src/blake2/` (BLAKE2b and the reference BlaMka round), `include/argon2.h`. Unmodified.
- Why: Argon2id derives the recovery key from the recovery phrase (`docs/CLIPBOARD_PROTOCOL.md`, `docs/ADR/` iOS crypto ADR); CryptoKit has no Argon2. Used single-threaded (`p = 1`).
