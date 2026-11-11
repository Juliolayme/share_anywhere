# Clipboard protocol (version 1)

How signed-in devices of one account share the keys that protect Clipboard Sync and cloud history, and (Phase 5B) how clipboard events move between them (PRD §2 "Account key bootstrap", §7.4, §7.5). The server stores ciphertext, wrapped keys, and public metadata only; it never holds a key that opens user content. Endpoints and access levels live in `docs/API.md`; token lifetimes, rate limits, and the wider threat model in `docs/SECURITY_MODEL.md`. Web implements this document in `web/src/lib/crypto/`; Android (Phase 6) and iOS (Phase 7) must reproduce `shared/protocol/schemas/clipboard-vectors.json` exactly.

Guests have no account, so they have no ADK, no Clipboard Sync, and no cloud history. Nothing in this document applies to file sharing.

## 1. Keys

### 1.1 Key hierarchy

| Key | What it is | Where it lives | Who can open it |
|---|---|---|---|
| ADK (`key_version` v) | 32 random bytes, one per version, starting at 1 | Each added device, wrapped by a device-local key (§1.9) | Every device that received it by setup, pairing, rotation, or recovery |
| `history-v1` subkey | HKDF of the ADK | Derived on demand, non-extractable | Holders of that ADK version |
| `clipboard-v1` subkey | HKDF of the ADK | Derived on demand, non-extractable | Holders of that ADK version |
| Device wrapping key | X25519 keypair per device | Private key on the device (§1.7); public key on the server | The device only |
| Recovery key | X25519 keypair derived from the 12-word phrase with Argon2id | Never stored; public key, salt, and parameters on the server | Whoever knows the phrase |
| Pairing key | Ephemeral X25519 keypair of a new device | Memory of the pairing screen | The new device, for one pairing |

Server-side records (all opaque to the server): the recovery blob (newest ADK wrapped to the recovery public key), one chain blob per version ≥ 2, pending rotation blobs per device, and one pairing blob per pairing.

### 1.2 Account Data Key and subkeys

- ADK: 32 bytes from a CSPRNG, generated on the first device when keys are set up. `key_version` is a positive integer; the first ADK is version 1 and each rotation adds one.
- The ADK is never used as a cipher key for content. Subkeys are `HKDF-SHA256(ikm = ADK, salt = empty, info = label, L = 32)` with label `clipboard-v1` for clipboard events and `history-v1` for cloud history entries. A subkey is an AES-256-GCM key.
- Implementations import subkeys as non-extractable keys where the platform allows it. The Web store unwraps the ADK straight into a non-extractable HKDF key, so reading history never puts ADK bytes in script memory.

### 1.3 Item encryption

Every clipboard event and history entry is encrypted on its own:

- AES-256-GCM with the subkey of the ADK version named by `key_version`, a fresh random 12-byte nonce per item, and a 16-byte tag appended to the ciphertext.
- AAD = UTF-8 of `<id>|<key_version>` in decimal, where id is the history `entry_id` or the clipboard `event_id` (UUIDs chosen by the client). An id never contains `|`.
- Wire fields: `nonce` (12 bytes) and `ciphertext` (ciphertext ‖ tag), base64url without padding. History payloads are at most 64 KB of ciphertext (`docs/API.md`).
- Writers always use the newest ADK version they hold. Readers pick the subkey from the row's `key_version`; a row whose version they lack shows as "locked on this device" until pairing, rotation pickup, or chain import supplies it.

The AAD binds a ciphertext to its row and version: the server cannot move a ciphertext to another entry or relabel its version without the decryption failing. A decryption failure is reported as one error with no detail.

### 1.4 Wrapping the ADK to a public key

Pairing, rotation, and recovery all deliver the ADK the same way (ECIES over X25519):

```text
shared = X25519(sender_priv, recipient_pub)            reject an all-zero result (low-order key)
key    = HKDF-SHA256(ikm = shared, salt = sender_pub || recipient_pub, info = "sa-wrap-v1", L = 32)
aad    = UTF-8("<purpose>|<key_version>")             purpose ∈ pair, rotate, recovery
blob   = sender_pub (32) || nonce (12) || AES-256-GCM(key, nonce, ADK, aad) (32 + 16)    = 92 bytes
```

- For `rotate` and `recovery` the sender key is a fresh ephemeral keypair per blob.
- For `pair` the sender key is the existing device's wrapping key; its public key also travels as `sender_public_key`, and the receiving side requires the blob's first 32 bytes to equal it.
- The purpose and version in the AAD make a blob useless for any other purpose or version: a rotation blob cannot be replayed as a pairing blob, nor a version 2 blob presented as version 3.
- Public keys are X25519 u-coordinates, exactly 32 bytes. Private keys are clamped as in RFC 7748.

### 1.5 Chain

The chain lets a holder of the newest ADK read everything older:

```text
chain blob for version v (v ≥ 2) = nonce (12) || AES-256-GCM(key = ADK(v), nonce, ADK(v-1), aad = UTF-8("chain|<v>"))   = 60 bytes
```

The rotating device uploads the chain blob for the new version. A device holding ADK(n) walks down: chain blob n gives ADK(n-1), blob n-1 gives ADK(n-2), and so on, stopping at a version it already holds (`GET /v1/keys/chain`).

### 1.6 Recovery phrase and Argon2id

- At setup the first device generates a 12-word phrase: 128 bits of CSPRNG entropy encoded with BIP-39 (English wordlist, 4-bit SHA-256 checksum). Only the BIP-39 wordlist and checksum are used, not its PBKDF2 seed. The phrase is shown once and never stored or sent.
- Normalization before hashing: Unicode NFKD, lower case, trimmed, words separated by single ASCII spaces. Entry screens validate word count, wordlist membership, and checksum before running Argon2id.
- `seed = Argon2id(password = UTF-8(normalized phrase), salt = 16 random bytes, m = 65536 KiB, t = 3, p = 1, version 0x13, 32 bytes)`. The salt and parameters are stored on the server with the recovery public key.
- Recovery private key = clamp(seed); `recovery_public_key = X25519(private, 9)`. The server stores only the public key and the newest ADK wrapped to it (purpose `recovery`).
- Clients accept server-supplied parameters only within m 65536–262144 KiB, t 3–10, p 1–4 and a 16-byte salt: a weaker setting would ease offline guessing of a leaked recovery blob, and a larger one could exhaust the device.
- The derivation takes about a second on a laptop. Web runs it in a Web Worker (pure JavaScript, so the CSP needs no `wasm-unsafe-eval`) and falls back to a main-thread loop that yields between slices where Workers are unavailable.

### 1.7 Device wrapping key

- Each added device creates an X25519 keypair once and registers the public key with `PUT /v1/keys/device`. Rotation blobs are wrapped to it; for pairing it is the existing device's sender key.
- Web: a WebCrypto X25519 key with a non-extractable private key, kept in IndexedDB as a `CryptoKey` (Chrome 133+, Firefox 130+, Safari 17+). Browsers without WebCrypto X25519 (for example Safari 16) fall back to `@noble/curves`; the private scalar is then script-visible while in use and is stored encrypted under the device KEK (§1.9). Both backends produce identical bytes (`clipboard-vectors.json`).
- Android and iOS: the private key is wrapped by a Keystore or Secure Enclave key (§1.9).
- A device that has not registered a public key (for example one that signed in before keys existed) receives no rotation blob; it pairs again or uses the phrase.

### 1.8 Flows

**Setup (first device).** After sign-up or the first sign-in of an account with `key_version = 0`, the device generates ADK v1, a phrase, and a salt, derives the recovery keypair, wraps ADK v1 to it, and sends `POST /v1/keys/setup {recovery_public_key, salt, params, recovery_blob}`. It stores ADK v1 locally only after `201`. On `409 keys_exist` another device won; this one discards its ADK and pairs or recovers instead. The phrase screen comes next and cannot be revisited.

**Pairing (new device, both devices signed in and added).**

1. The new device creates an ephemeral keypair and calls `POST /v1/keys/pairings {ephemeral_public_key}` → `{pairing_id, code, expires_at}` (10 minutes).
2. It shows a QR code and the same text to paste: `sa1.<code>.<fingerprint>`, where fingerprint = base64url of the first 16 bytes of SHA-256(ephemeral public key).
3. The existing device scans or pastes it, calls `GET /v1/keys/pairings/by-code/{code}`, and refuses to continue unless the returned `ephemeral_public_key` matches the fingerprint. It should show the returned `device_name` for the user to confirm.
4. It wraps its newest ADK to the ephemeral key with its device key (purpose `pair`) and sends `POST /v1/keys/pairings/by-code/{code}/wrap {key_version, sender_public_key, blob}`.
5. The new device polls `GET /v1/keys/pairings/{pairing_id}` until `ready`, checks that `sender_public_key` is one of the account's registered device keys (`GET /v1/keys` `devices`) and that the blob is wrapped by it, unwraps, and stores the ADK. It then imports the chain (§1.5) and registers its own device key.

The fingerprint closes the gap where a dishonest server swaps in its own ephemeral key for the code: the existing device would wrap the ADK to a key the server holds.

**Recovery (new device, phrase).** `GET /v1/keys/recovery` → `{key_version, recovery_blob, salt, params}`; the device validates the phrase, derives the recovery keypair, unwraps (purpose `recovery`), stores the ADK, imports the chain, and registers its device key. A well-formed but wrong phrase fails as a decryption error; the screen says the phrase does not match.

**Rotation (after revoking a device).** The revoking device calls `DELETE /v1/devices/{id}`, then `GET /v1/keys`. If its newest local version is behind `key_version`, it first accepts its pending blobs. It then generates ADK(v+1) and sends `POST /v1/keys/rotate` with:

- `chain_blob`: ADK(v) under ADK(v+1) (§1.5);
- `recovery_blob`: ADK(v+1) wrapped to the recovery public key, so the phrase keeps working without being re-entered;
- `device_blobs`: ADK(v+1) wrapped (purpose `rotate`) to every remaining added device with a registered public key, the rotating device included as a safety copy.

It stores ADK(v+1) only after `200`. On `409 key_version_conflict` or `409 devices_changed` it discards the new ADK, refreshes `GET /v1/keys`, and starts again. The revoked device keeps the versions it already had (old entries it could read before), but it receives no blob for v+1 and loses API access with its account session, so it cannot read anything written afterwards.

**Pending pickup.** Each device reads `pending` from `GET /v1/keys` when it starts an account session and whenever it finds a newer `key_version` than it holds, unwraps each blob (purpose `rotate`, version bound by the AAD), stores it, and acknowledges with `DELETE /v1/keys/pending/{key_version}`. Storing the same bytes twice is a no-op; different bytes for a stored version are refused.

### 1.9 Local storage

| Platform | ADK at rest | Device private key | On sign-out |
|---|---|---|---|
| Web | IndexedDB database `share-anywhere-keys`; each version encrypted with AES-256-GCM under a non-extractable device KEK (a `CryptoKey` kept in the same database), AAD `adk\|<version>` | Non-extractable `CryptoKey` in the same database; fallback backend: scalar encrypted under the KEK, AAD `device\|x25519` | All records and the KEK are erased |
| Android | Wrapped by an Android Keystore AES key (PRD §7.5) | Wrapped by the same Keystore key | Keys and wrapped blobs deleted |
| iOS | Wrapped by a Secure Enclave `P256.KeyAgreement` derived key, Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, excluded from backups (PRD §7.5) | Same protection | Keychain items deleted |

Web specifics:

- Nothing goes to Web Storage, cookies, logs, or analytics. Raw ADK bytes exist only transiently while wrapping for pairing, rotation, or setup, and are zeroed afterwards (best effort in JavaScript).
- If IndexedDB is unavailable (some private modes, blocked site data) the library raises a typed "storage unavailable" error and the UI explains that Clipboard Sync and cloud history cannot keep keys in this browser.
- Browsers may evict IndexedDB under storage pressure, and users can clear site data. The app should ask for persistent storage after setup, pairing, or recovery (`requestPersistentStorage()` wraps `navigator.storage.persist()`). An evicted device is like a new device: it pairs again or uses the phrase; server-side history is unaffected.

### 1.10 Encodings and limits

- Binary fields on the wire are base64url without padding; decoders reject padding, other alphabets, and non-canonical trailing bits.
- Public keys: exactly 32 bytes. Wrapped-ADK blobs: exactly 92 bytes. Chain blobs: exactly 60 bytes. The server caps every blob at 4 KB.
- `key_version`: positive integer; the AAD uses its decimal form without leading zeros.

### 1.11 Threat notes

- **Server compromise.** An attacker with the database gets ciphertext, wrapped blobs, public keys, and the Argon2id salt and parameters. Opening the recovery blob requires guessing a 128-bit phrase through Argon2id; no other blob opens without a device private key.
- **Dishonest server.** It can withhold or reorder data and refuse service, but it cannot read content: it cannot substitute a pairing key (fingerprint check), forge a pairing blob from an unknown sender (sender check against registered device keys and the blob prefix), move a ciphertext between rows or versions (AAD), or replay a blob for another purpose or version (AAD). Residual risk: the device list in `GET /v1/keys` comes from the server, so a dishonest server could add a public key of its own and receive the next rotation blob. Out-of-band verification of device keys is not part of v1.
- **Revoked device.** It keeps what it already decrypted and the ADK versions it held; rotation stops it from reading anything new. Content written before the revocation is not re-encrypted.
- **Stolen unlocked device or XSS.** Script running in the app's origin can use the non-extractable keys while it runs, but cannot copy them out; on the fallback X25519 backend it could read the device private scalar. CSP (`script-src 'self'`) and the absence of third-party scripts are the main defense.
- **Phrase hygiene.** The phrase is shown once. Anyone who learns it can unwrap the newest ADK through the recovery blob and read the account's encrypted history, including versions created later, because each rotation re-wraps the new ADK to the same recovery key. Replacing the phrase is not part of v1.
- **Loss.** If every device holding the ADK and the recovery phrase are all lost, old clipboard and history entries are unrecoverable: the server cannot decrypt them and support cannot restore them. The UI must say so (PRD §7.5), at least on the phrase screen.
- **Low-order keys.** X25519 results of all zeros are rejected on both backends.

### 1.12 Test vectors and implementation

`shared/protocol/schemas/clipboard-vectors.json` holds, from fixed inputs:

- the ADK and both subkeys;
- one history and one clipboard item encrypted with a fixed nonce (plaintext, AAD, ciphertext);
- the wrap of a fixed ADK with fixed sender and recipient keys (clamped scalars, public keys, shared secret, HKDF salt, wrap key) for each purpose;
- a chain blob;
- a recovery phrase from fixed entropy, a messy typed form and its normalization, the Argon2id seed with a fixed salt, the clamped private key, and the public key.

`web/src/lib/crypto/vectors.test.ts` regenerates (`UPDATE_VECTORS=1`) and compares it with both X25519 backends. Change it only together with a format version bump. Fixed nonces and keys exist only for vectors; production code always draws fresh randomness.

Web modules (`web/src/lib/crypto/`): `adk.ts` (ADK, subkeys), `item.ts` (item encryption, wire helpers), `wrap.ts` (ECIES and chain), `phrase.ts`, `argon.ts`, `recovery.ts`, `recovery.worker.ts` (phrase and recovery key), `x25519.ts` and `device-key.ts` (X25519 backends, device key), `store.ts` (IndexedDB key store), `bootstrap.ts`, `pairing.ts`, `rotation.ts` (flows). Account screens load the library lazily so it stays out of the main bundle.

## 2. Clipboard events

*Placeholder: Phase 5B specifies the clipboard event protocol here (event format, `seq` cursors, idempotency, WebSocket notifications, size and retention limits, sensitive-content rules), using the `clipboard-v1` subkey and item encryption from §1.3.*
