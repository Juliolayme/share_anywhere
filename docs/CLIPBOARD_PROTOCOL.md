# Clipboard protocol (version 1)

How signed-in devices of one account share the keys that protect Clipboard Sync and cloud history, and (Phase 5B) how clipboard events move between them (PRD §2 "Account key bootstrap", §7.4, §7.5). The server stores ciphertext, wrapped keys, and public metadata only; it never holds a key that opens user content. Endpoints and access levels live in `docs/API.md`; token lifetimes, rate limits, and the wider threat model in `docs/SECURITY_MODEL.md`. Web implements §1 in `web/src/lib/crypto/` and §2 in `web/src/features/clipboard/`; Android (Phase 6) and iOS (Phase 7) must reproduce `shared/protocol/schemas/clipboard-vectors.json` exactly.

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
| Version signing key | Ed25519 keypair derived from ADK(v) (§1.13) | Derived on demand, erased after use; `verify_key(v)` on the server | Holders of that ADK version |

Server-side records (all opaque to the server): the recovery blob (newest ADK wrapped to the recovery public key), one chain blob per version ≥ 2, pending rotation blobs per device, and one pairing blob per pairing. Public authenticity records (§1.13): `verify_key(v)` for every version, the rotation signature for every version ≥ 2, the recovery anchor, and each device key's proof.

### 1.2 Account Data Key and subkeys

- ADK: 32 bytes from a CSPRNG, generated on the first device when keys are set up. `key_version` is a positive integer; the first ADK is version 1 and each rotation adds one.
- The ADK is never used as a cipher key for content. Subkeys are `HKDF-SHA256(ikm = ADK, salt = empty, info = label, L = 32)` with label `clipboard-v1` for clipboard events and `history-v1` for cloud history entries. A subkey is an AES-256-GCM key.
- Implementations import subkeys as non-extractable keys where the platform allows it. The Web store unwraps the ADK straight into a non-extractable HKDF key, so reading history never puts ADK bytes in script memory.

### 1.3 Item encryption

Every clipboard event and history entry is encrypted on its own:

- AES-256-GCM with the subkey of the ADK version named by `key_version`, a fresh random 12-byte nonce per item, and a 16-byte tag appended to the ciphertext.
- AAD = UTF-8 of `<id>|<key_version>` in decimal, where id is the history `entry_id` or the clipboard `event_id` (UUIDs chosen by the client). An id never contains `|`.
- **Canonical id text.** `entry_id` and `event_id` are always written as the lowercase canonical 8-4-4-4-12 hex form of the UUID (36 characters, `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`), and that exact text goes into the AAD and onto the wire. Clients generate ids in this form (Web: `crypto.randomUUID()` for clipboard events, the SHA-256-derived version-8 UUID for history entries, both checked by `newItemId`/`itemIdFromBytes` in `web/src/lib/crypto/item.ts`). The server rejects any other form (upper case, braces, missing hyphens, URN prefix) with `400` instead of normalizing it, so the id a reader puts in the AAD is byte-for-byte the id the writer used.
- **Ciphertext length (v1).** The plaintext is the item itself and GCM adds only the tag, so `len(ciphertext) == payload_size + 16` for clipboard events, where `payload_size` is the plaintext's UTF-8 byte length. The server enforces this equality on create (`400` otherwise).
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

The rotating device uploads the chain blob for the new version. A device holding ADK(n) walks down: chain blob n gives ADK(n-1), blob n-1 gives ADK(n-2), and so on, stopping at a version it already holds (`GET /v1/keys/chain`). Each older key is checked before it is stored (§1.13 "Chain import"): it must derive `versions[v-1].verify_key`, and `versions[v].signature` must verify with it over the rotation message built from chain blob v; otherwise the walk stops and nothing more is stored.

### 1.6 Recovery phrase and Argon2id

- At setup the first device generates a 12-word phrase: 128 bits of CSPRNG entropy encoded with BIP-39 (English wordlist, 4-bit SHA-256 checksum). Only the BIP-39 wordlist and checksum are used, not its PBKDF2 seed. The phrase is shown once and never stored or sent.
- Normalization before hashing: Unicode NFKD, lower case, trimmed, words separated by single ASCII spaces. Entry screens validate word count, wordlist membership, and checksum before running Argon2id.
- `seed = Argon2id(password = UTF-8(normalized phrase), salt = 16 random bytes, m = 65536 KiB, t = 3, p = 1, version 0x13, 32 bytes)`. The salt and parameters are stored on the server with the recovery public key.
- Recovery private key = clamp(seed); `recovery_public_key = X25519(private, 9)`. The server stores only the public key and the newest ADK wrapped to it (purpose `recovery`).
- Clients accept server-supplied parameters only within m 65536–262144 KiB, t 3–10, p 1–4 and a 16-byte salt: a weaker setting would ease offline guessing of a leaked recovery blob, and a larger one could exhaust the device.
- The derivation takes about a second on a laptop. Web runs it in a Web Worker (pure JavaScript, so the CSP needs no `wasm-unsafe-eval`) and falls back to a main-thread loop that yields between slices where Workers are unavailable.

### 1.7 Device wrapping key

- Each added device creates an X25519 keypair once. It registers the public key with `PUT /v1/keys/device` only once it holds the ADK (after setup, pairing, or recovery), with a proof made by the newest ADK version it holds, which must be the account's current version (§1.13); never right after "Add this device". It registers again whenever it holds a newer version than its registration (after a pickup, rotation, pairing, recovery, or chain import). Rotation blobs are wrapped to it; for pairing it is the existing device's sender key.
- Web: a WebCrypto X25519 key with a non-extractable private key, kept in IndexedDB as a `CryptoKey` (Chrome 133+, Firefox 130+, Safari 17+). Browsers without WebCrypto X25519 (for example Safari 16) fall back to `@noble/curves`; the private scalar is then script-visible while in use and is stored encrypted under the device KEK (§1.9). Both backends produce identical bytes (`clipboard-vectors.json`).
- Android and iOS: the private key is wrapped by a Keystore or Secure Enclave key (§1.9).
- A device that has not registered a public key proven by the current version (for example one that was added but never paired, or one left behind at an older version) receives no rotation blob; it pairs again or uses the phrase.

### 1.8 Flows

**Setup (first device).** After sign-up or the first sign-in of an account with `key_version = 0`, the device generates ADK v1, a phrase, and a salt, derives the recovery keypair and the anchor key from the same Argon2id seed (then erases the seed), wraps ADK v1 to the recovery key, signs the recovery public key with ADK v1's signing key, and sends `POST /v1/keys/setup {recovery_public_key, salt, params, recovery_blob, verify_key, recovery_anchor, recovery_key_signature}` (§1.13). The server checks the signature with the posted `verify_key` (`403 recovery_key_unverified` otherwise) and keeps it; the recovery public key never changes afterwards. It stores ADK v1 locally only after `201`, then registers its device key with a proof by version 1. On `409 keys_exist` another device won; this one discards its ADK and pairs or recovers instead. The phrase screen comes next and cannot be revisited.

**Pairing (new device, both devices signed in and added).**

1. The new device creates an ephemeral keypair and calls `POST /v1/keys/pairings {ephemeral_public_key}` → `{pairing_id, code, expires_at}` (10 minutes).
2. It shows a QR code and the same text to paste: `sa1.<code>.<fingerprint>`, where fingerprint = base64url of the first 16 bytes of SHA-256(ephemeral public key).
3. The existing device scans or pastes it, calls `GET /v1/keys/pairings/by-code/{code}`, and refuses to continue unless the returned `ephemeral_public_key` matches the fingerprint. It should show the returned `device_name` for the user to confirm.
4. It wraps its newest ADK to the ephemeral key with its device key (purpose `pair`) and sends `POST /v1/keys/pairings/by-code/{code}/wrap {key_version, sender_public_key, blob}`.
5. The new device polls `GET /v1/keys/pairings/{pairing_id}` until `ready`, checks that `sender_public_key` is one of the account's registered device keys (`GET /v1/keys` `devices`) and that the blob is wrapped by it, unwraps, and verifies the ADK against `GET /v1/keys/chain` (§1.13 "Pairing receive") before storing it. It then imports the chain (§1.5) and registers its own device key with a proof.

The fingerprint closes the gap where a dishonest server swaps in its own ephemeral key for the code: the existing device would wrap the ADK to a key the server holds.

**Recovery (new device, phrase).** `GET /v1/keys/recovery` → `{key_version, recovery_blob, salt, params, recovery_anchor}` and `GET /v1/keys/chain`; the device validates the phrase, derives the recovery keypair and anchor key, unwraps (purpose `recovery`), verifies the anchor, that the recovery public key and its signature in `GET /v1/keys` are the phrase's own, the signature chain, and the verify key (§1.13 "Recovery"), then stores the ADK, imports the chain, and registers its device key with a proof. A well-formed but wrong phrase fails as a decryption error; the screen says the phrase does not match. A right phrase whose account does not verify stores nothing and says so.

**Rotation (after revoking a device, or when one is owed).** The revoking device remembers the device ID (IndexedDB, below), calls `DELETE /v1/devices/{id}`, then `GET /v1/keys`. If its newest local version is behind `key_version`, it first accepts its pending blobs. Precondition: its own wrapping key is registered and proven at the current version (the server refuses others with `403 device_key_unproven`; clients re-prove before rotating), it holds ADK(1) (after the chain import) and `recovery.signature` from `GET /v1/keys` verifies, with the verify_key(1) it derives from its own ADK(1), over `"sa-recoverykey-v1|" + b64u(recovery.public_key)` (§1.13). Otherwise it refuses to rotate and sends nothing: the key state becomes `rejected` (or `legacy` when the signature is `null`, an account set up before it existed). It then generates ADK(v+1) and sends `POST /v1/keys/rotate` with:

- `chain_blob`: ADK(v) under ADK(v+1) (§1.5);
- `recovery_blob`: ADK(v+1) wrapped to the recovery public key checked above, so the phrase keeps working without being re-entered and a server cannot list a key of its own;
- `device_blobs`: ADK(v+1) wrapped (purpose `rotate`) to every remaining added device whose registered public key carries a proof by the current version v that verifies with the rotating device's own ADK(v) (§1.13), the rotating device included as a safety copy, and never to the device just revoked (`exclude`) or any device this browser revoked earlier whose exclusion has not yet been part of a successful rotation, whatever the server lists;
- `verify_key` and `signature`: verify_key(v+1) and the rotation signed with version v (§1.13).

It stores ADK(v+1) only after `200`, then forgets the excluded IDs it remembered. On `409 key_version_conflict` or `409 devices_changed` (body `{missing, unexpected}`: devices that should have had a blob, and blobs the server does not want) it discards the new ADK, refreshes `GET /v1/keys` (picking up pending blobs and re-proving), and tries once more with the refreshed device list. After `409 key_version_conflict`, when the refreshed `key_version` is past the version its rotation started from and `rotation_due` is false, another device already made the rotation: it picks up that device's blob and does not rotate again. When the refresh finds that this device lacks the newest key (`not_ready`), it runs a key check (pick up or pair) instead of offering Retry. `403 rotation_unauthorized` (the signature does not verify against the stored verify_key(v)), and a conflict that persists after the retry, are this device's own update being refused: the key state becomes `refused` ("This device couldn't update your account keys", with Pair again and Use recovery phrase), distinct from a rejected incoming change. `409 keys_legacy` (keys from before §1.13) is shown as legacy keys. Any other failure leaves the rotation owed (below). The revoked device keeps the versions it already had (old entries it could read before), but it receives no blob for v+1 and loses API access with its account session, so it cannot read anything written afterwards; signing in again with the password and a kept ADK(v) does not help, because a device key proven by an old version is refused (§1.13).

**Rotation owed.** Whenever an added device that has a registered device key leaves the account by any path (revoked, signed out, password reset or change, refresh secret reuse, expiry, identity reset), the server sets `rotation_due` in `GET /v1/keys` in the same transaction; a successful rotation clears it. On every key check, a device that holds the current version and sees `rotation_due = true` rotates as above with an empty `exclude`. If that fails (offline, a race that did not settle), the server still says `rotation_due`, so the next key check tries again, and Devices shows that new keys could not be sent yet. A device that is not ready leaves it to one that is. Open Web tabs run a key check when they become visible and on the 30-second sync tick (at most one at a time and at most once per 30 seconds), so they pick up rotations, re-prove, and make owed rotations without a reload.

**Remembered exclusions (Web).** The IDs of devices this browser revoked are kept in IndexedDB (`share-anywhere-sync`, its own record per account, never Web Storage) from just before `DELETE /v1/devices/{id}` until a rotation by this browser that excluded them has succeeded; every rotation it makes in between, owed ones included, excludes them. Each ID is stored with the newest key version the account was known to be at when the device was revoked: the larger of this browser's newest ADK and the server's `key_version`, read just before `DELETE /v1/devices/{id}` (`<id>@<version>`, QA round 7). If the server's version cannot be read, the revoke is not sent and the user retries (fail closed, QA round 8). An ID is dropped at once if the server answers the revoke with an error (the device stays). At the start of each rotation by a ready device it is also dropped once it is provably obsolete (QA round 6): either the account has rotated past that version and the device has no registered key now, or the device holds a key proven at a newer version, checked with this browser's own copy of that version. Both mean the device obtained a post-revoke key legitimately (pairing or recovery). Nothing else drops it. If a rotation is refused with `devices_changed` listing a remembered ID as `missing` and `GET /v1/devices` still lists that device (the revoke request got no answer, or the device signed in again before the rotation), the browser sends the revoke again and keeps the device excluded; it never re-includes it. A server that ignores the repeated revoke can only keep the rotation from happening (denial of service, not disclosure). The exclusion is by device ID, so it does not stop a colluding departed device that held the current ADK: with that key it can prove a wrapping key for a fresh device ID that the server then lists (§1.11 "Dishonest server"). Like the rest of the sync bookkeeping it is erased when the browser leaves the account. A `GET /v1/keys` with `key_version >= 1` but no `recovery` (an honest server always returns the signed recovery key) puts the rotating device in the `rejected` key state instead of skipping the rotation silently.

**History uploads.** `POST /v1/history/entries` takes new entries only under the account's current key version (`409 key_version_conflict` otherwise; repeating a stored `entry_id` still returns its seq). A client that gets the conflict runs a key check (picking up the rotation) and retries the upload once with the newest key.

**Pending pickup.** Each device reads `pending` from `GET /v1/keys` on every key check (account session start, tab shown again, the 30-second tick, a history conflict) and whenever it finds a newer `key_version` than it holds, unwraps each blob (purpose `rotate`, version bound by the AAD), verifies it (§1.13 "Rotation pickup"), stores it, acknowledges with `DELETE /v1/keys/pending/{key_version}`, and re-proves its device key with the new version. A blob that does not verify is neither stored nor acknowledged, and the UI shows "A key change on your account could not be verified" with Pair again and Use recovery phrase. Storing the same bytes twice is a no-op; different bytes for a stored version are refused.

### 1.9 Local storage

| Platform | ADK at rest | Device private key | On sign-out |
|---|---|---|---|
| Web | IndexedDB database `share-anywhere-keys`; each version encrypted with AES-256-GCM under a non-extractable device KEK (a `CryptoKey` kept in the same database), AAD `adk\|<version>` | Non-extractable `CryptoKey` in the same database; fallback backend: scalar encrypted under the KEK, AAD `device\|x25519` (also used where the engine stores a WebCrypto X25519 key but reads the record back empty, seen in Playwright's WebKit: `getOrCreateDeviceKey` reads the key back once and falls back). The same engine rejects X25519 scalars whose first byte is zero (pkcs8 import `DataError`, `generateKey` `OperationError`, about 1 in 32 after clamping): generation retries with a fresh key and an import from a fixed secret (recovery seed) uses the JS backend, which gives the same X25519 results | All records and the KEK are erased |
| Android | Wrapped by an Android Keystore AES key (PRD §7.5) | Wrapped by the same Keystore key | Keys and wrapped blobs deleted |
| iOS | Wrapped by a Secure Enclave `P256.KeyAgreement` derived key, Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, excluded from backups (PRD §7.5) | Same protection | Keychain items deleted |

Web specifics:

- Nothing goes to Web Storage, cookies, logs, or analytics. Raw ADK bytes exist only transiently while wrapping for pairing, rotation, or setup, deriving signing keys and proofs, or verifying a received key against the held ones, and are zeroed afterwards (best effort in JavaScript). They are not non-extractable: the key store decrypts them into script memory (`unwrapAdkRaw`), so script running in the origin can read them (§1.11).
- If IndexedDB is unavailable (some private modes, blocked site data) the library raises a typed "storage unavailable" error and the UI explains that Clipboard Sync and cloud history cannot keep keys in this browser.
- Browsers may evict IndexedDB under storage pressure, and users can clear site data. The app should ask for persistent storage after setup, pairing, or recovery (`requestPersistentStorage()` wraps `navigator.storage.persist()`). An evicted device is like a new device: it pairs again or uses the phrase; server-side history is unaffected.

### 1.10 Encodings and limits

- Binary fields on the wire are base64url without padding; decoders reject padding, other alphabets, and non-canonical trailing bits.
- Public keys: exactly 32 bytes. Wrapped-ADK blobs: exactly 92 bytes. Chain blobs: exactly 60 bytes. The server caps every blob at 4 KB.
- `key_version`: positive integer; the AAD uses its decimal form without leading zeros.

### 1.11 Threat notes

- **Server compromise.** An attacker with the database gets ciphertext, wrapped blobs, public keys, and the Argon2id salt and parameters. Opening the recovery blob requires guessing a 128-bit phrase through Argon2id; no other blob opens without a device private key.
- **Dishonest server.** It can withhold or reorder data and refuse service, but it cannot read content: it cannot substitute a pairing key (fingerprint check), forge a pairing blob from an unknown sender (sender check against registered device keys and the blob prefix), move a ciphertext between rows or versions (AAD), replay a blob for another purpose or version (AAD), get a rotation blob wrapped to a device key of its own (device keys need a proof made with the current ADK, §1.13), get the new ADK through the recovery blob by listing a recovery key of its own (the recovery public key is signed at setup with ADK v1, and a rotating device checks that signature with its own ADK v1 before wrapping, §1.13; before Phase 5A QA round 3 it could, with no user action, through an owed rotation), make existing devices adopt an ADK it chose (rotation pickup needs a chain link to the held key, and pairing or recovery on a device that holds an ADK is anchored on the held keys, §1.13), or make a device drop its keys by claiming the account has no key or an older one (the device keeps its keys and shows the key problem). Residual risks: pairing receive on a device holding no ADK is not anchored (§1.13). `rotation_due` is only the server's word, so a dishonest server can set it again and again to force repeated rotations: versions grow, and a device that is offline across two of them is pushed to pairing again (denial of service, not disclosure; every rotation still wraps only to proofs by the current version and to the signed recovery key). It can also hide `rotation_due`. And with a departed device that colludes with it (one that held the current key), it can list that device, or a fresh device ID whose wrapping key the departed device proved with the current ADK, in `GET /v1/keys` for an owed rotation, so the departed device receives the next key. The Web client's remembered exclusions (§1.8) stop only the IDs it revoked itself, and are never dropped on the server's word; a fresh ID, or a device that left by signing out, a reset, or expiry, is not covered. Rotating again from a device the colluder does not control, after the colluding device is gone and without it re-listed, ends that access for later versions.
- **Password-only attacker.** Someone who knows the password can sign in and add a device, but without the ADK it cannot prove a device key (so no rotation is wrapped to it), cannot sign a rotation (the server answers `403 rotation_unauthorized`), and a rotation blob it got delivered some other way is refused by every device (QA round 1 P0-1).
- **Revoked device.** It keeps what it already decrypted and the ADK versions it held; rotation stops it from reading anything new. Its holder may also know the password: signing in again and proving a device key with the kept ADK(v) is refused once the account has moved to v+1 (`409 key_version_conflict`), and rotations wrap only to proofs by the current version, so it never receives a newer key. The rotation after it leaves is owed by the server (`rotation_due`) and made by the next ready device, even when the revoking device's own rotation failed or it left by signing out. Content written before the revocation is not re-encrypted.
- **Stolen unlocked device or XSS.** Script running in the app's origin can use the non-extractable keys while it runs, but cannot copy them out; on the fallback X25519 backend it could read the device private scalar. Non-extractability protects only the device KEK, the subkey `CryptoKey`s, and the WebCrypto device private key: the ADK itself is decrypted into script memory when needed (`unwrapAdkRaw`), so in-origin script can read raw ADK bytes while it runs. CSP (`script-src 'self'`) and the absence of third-party scripts are the main defense.
- **Phrase hygiene.** The phrase is shown once. Anyone who learns it can unwrap the newest ADK through the recovery blob and read the account's encrypted history, including versions created later, because each rotation re-wraps the new ADK to the same recovery key. Replacing the phrase is not part of v1.
- **Loss.** If every device holding the ADK and the recovery phrase are all lost, old clipboard and history entries are unrecoverable: the server cannot decrypt them and support cannot restore them. The UI must say so (PRD §7.5), at least on the phrase screen.
- **Low-order keys.** X25519 results of all zeros are rejected on both backends.

### 1.12 Test vectors and implementation

`shared/protocol/schemas/clipboard-vectors.json` holds, from fixed inputs:

- the ADK and both subkeys;
- one history and one clipboard item encrypted with a fixed nonce (plaintext, AAD, ciphertext);
- the wrap of a fixed ADK with fixed sender and recipient keys (clamped scalars, public keys, shared secret, HKDF salt, wrap key) for each purpose;
- a chain blob;
- a recovery phrase from fixed entropy, a messy typed form and its normalization, the Argon2id seed with a fixed salt, the clamped private key, and the public key;
- `key_authenticity` (generated by the Go backend from the `chain` inputs): signing seeds and verify keys for ADK v1 and v2, the rotation message and signature for version 2, a device key message and proof, the anchor key, message, and recovery anchor from a fixed seed, and `recovery_key` (a fixed recovery public key, its message, and the signature by ADK v1). `web/src/lib/crypto/authenticity-vectors.test.ts` and the Go test both verify every value.

`web/src/lib/crypto/vectors.test.ts` regenerates (`UPDATE_VECTORS=1`) and compares it with both X25519 backends. Change it only together with a format version bump. Fixed nonces and keys exist only for vectors; production code always draws fresh randomness.

Web modules (`web/src/lib/crypto/`): `adk.ts` (ADK, subkeys), `item.ts` (item encryption, wire helpers), `wrap.ts` (ECIES and chain), `phrase.ts`, `argon.ts`, `recovery.ts`, `recovery.worker.ts` (phrase and recovery key), `x25519.ts` and `device-key.ts` (X25519 backends, device key), `store.ts` (IndexedDB key store), `authenticity.ts` (version signing keys, proofs, anchor, verification rules), `bootstrap.ts`, `pairing.ts`, `rotation.ts` (flows). Account screens load the library lazily so it stays out of the main bundle.

### 1.13 Key authenticity

Wrapping alone says nothing about who chose a key: any added device, including one whose user only knows the password, could otherwise post `POST /v1/keys/rotate` with an ADK it chose, and every device would accept a rotation blob it can open (QA round 1 P0-1). Every ADK version therefore carries a signing key that only its holders can derive (ADR 0012, amended by ADR 0014 and ADR 0015; endpoints in `docs/API.md`). Ed25519 is RFC 8032 (pure, deterministic; Web verifies strictly, without ZIP-215 leniency); HKDF is HKDF-SHA256 with an empty salt; `b64u` is base64url without padding; `|` is a literal separator and numbers are decimal.

```text
sign_seed(v)    = HKDF(ikm = ADK(v), info = "sa-keyver-sign-v1", L = 32)
verify_key(v)   = Ed25519 public key of sign_seed(v)                                   (32 bytes, stored per version)
rotation sig    = Ed25519_sign(sign_seed(v),   "sa-rotate-v1|" + (v+1) + "|" + b64u(verify_key(v+1)) + "|" + b64u(SHA-256(chain_blob)))
device proof    = Ed25519_sign(sign_seed(kv),  "sa-devkey-v1|" + <device id, lowercase UUID> + "|" + kv + "|" + b64u(public_key))
anchor key      = HKDF(ikm = recovery_seed, info = "sa-recovery-anchor-v1", L = 32)  (recovery_seed = the Argon2id output of §1.6)
recovery_anchor = HMAC-SHA256(anchor key, "sa-anchor-v1|" + b64u(verify_key(1)))
recovery key sig = Ed25519_sign(sign_seed(1), "sa-recoverykey-v1|" + b64u(recovery_public_key))   (setup only; ADR 0015)
```

Server checks: setup requires `verify_key`, `recovery_anchor`, and `recovery_key_signature`, which must verify with the posted `verify_key` (`403 recovery_key_unverified`, nothing stored; `400` when malformed); a rotation must be signed by the stored verify_key(v) (`403 rotation_unauthorized`, nothing stored); a device key registration (`{public_key, key_version, proof}`) must name the account's current version (`409 key_version_conflict` otherwise, nothing stored) and carry a proof by it for the caller's device ID from the token (`403 device_key_unproven`); a rotation from v to v+1 must carry a blob for exactly the other added devices whose registered proof is by version v (the caller may add a safety copy for itself), otherwise `409 devices_changed` with `{missing, unexpected}`; devices with an older proof get nothing and must pair again; accounts created before key authenticity have no verify key and are refused (`409 keys_legacy`). new history entries must use the current key version (`409 key_version_conflict`). `GET /v1/keys` carries `rotation_due` (§1.8 "Rotation owed") and `recovery.signature` (`null` for accounts set up before it existed), `GET /v1/keys/chain` returns `{chain, versions: [{key_version, verify_key, signature}]}`, and `GET /v1/keys/recovery` adds `recovery_anchor`.

Client rules (Web: `web/src/lib/crypto/authenticity.ts`, `rotation.ts`, `bootstrap.ts`, `pairing.ts`; comparisons of key material are constant-time):

- **Rotation pickup** (`acceptPendingBlobs`): versions ascending. A blob for version v is accepted only when the device already holds ADK(v-1), the chain link of v opened with the candidate yields exactly that ADK(v-1), and the candidate derives `versions[v].verify_key`. Only a holder of ADK(v-1) can make such a link. Otherwise nothing is stored or acknowledged and the key state becomes `rejected`.
- **Rotating** (`prepareRotation`): a device gets a blob only when its proof is by the current version v and verifies with verify_key(v) derived from the rotating device's own ADK(v). Others are skipped: `no_key` (nothing registered), `stale` (a proof by an older version, such as a revoked laptop that kept ADK(v-1)), `unproven` (a proof that does not verify, is malformed, or claims a newer version), `excluded` (the device just revoked). The rotation is signed with version v. Before anything is generated, the device must hold ADK(1) and `recovery.signature` must verify with verify_key(1) derived from that own ADK(1) over the recovery key message; otherwise it refuses (`unverified`, key state `rejected`; `null` is `keys_legacy`) and sends nothing (ADR 0015). A rotation is also made whenever the server says one is owed (§1.8), excluding only the devices this browser remembers revoking.
- **Recovery** (`recoverWithPhrase`): the anchor recomputed from the phrase must authenticate `versions[1].verify_key`; the recovery public key derived from the phrase must equal `recovery.public_key` of `GET /v1/keys`, and `recovery.signature` must verify with that `versions[1].verify_key`; each `versions[k].signature` (k = 2..v) must verify with `versions[k-1].verify_key` over the rotation message built from `chain[k]`; the recovered ADK(v) must derive `versions[v].verify_key`. Any failure is `recovery_unverified`; an account without an anchor is `keys_legacy`. The phrase is the root of trust, so recovery is fully anchored.
  When the device already holds an ADK, the account must also be consistent with it (the pairing rule below).
- **Pairing receive** (`acceptPairing`): the received ADK(v) must derive `versions[v].verify_key`. If the device holds no ADK, the signature chain 2..v must verify. If it holds any ADK, with k its highest held version, the account is anchored on the held keys (`assertAnchoredOnHeld`): v ≥ k; every held ADK(h) derives `versions[h].verify_key`; the signatures k+1..v verify starting from the held verify_key(k), so versions below k are never taken from the server; and opening the chain from the received ADK(v) down to k yields exactly the held ADK(k) (for v = k, the received key must equal it). Any failure stores nothing.
- **Chain import** (`importChain`): walking down from the newest held ADK(v), the ADK(v-1) opened from chain link v must derive `versions[v-1].verify_key`, and `versions[v].signature` must verify with it over the rotation message built from chain link v. Otherwise the walk stops with `unverified` (`keys_legacy` for a legacy row) and that version is not stored. This holds against anyone who does not hold a newer ADK: a server colluding with a departed device that kept ADK(k) can forge links and signatures for versions ≤ k (and so a substitute ADK(1) and recovery key signature) for a device that paired at a later version; that is the colluding-departed-device case of `docs/SECURITY_MODEL.md` §7, not a separate guarantee (QA round 4 P2-3).
- **Registering the device key**: only once the device holds the ADK, with a proof by the newest version it holds (`proveDeviceKey`), and again whenever that version is newer than the `key_version` of its own registration in `GET /v1/keys` (or it has none). On `409 key_version_conflict` the device refreshes `GET /v1/keys`, picks up pending blobs, and retries once. A second conflict when the server's `key_version` is above every version the device holds means it was left behind (no blob for a version in between): the key state is `pair`. A second conflict at an equal version, or `403 device_key_unproven`, is `refused`.
- **No silent wipe**: when `GET /v1/keys` reports `key_version 0`, or a version lower than the highest held, for the same account, the device keeps its keys and shows the key problem (`rejected`). Keys are erased only on sign-out, when a different account signs in on the browser, or when the account session ends.

Limitation (pairing receive on a device holding no ADK): such a device has nothing of its own to anchor to. A dishonest server that controls everything the new device sees could present a whole fabricated account (its own versions, signatures, and a pairing blob from a device key of its own) and the checks above would pass. The pairing fingerprint protects the existing device's side only. A device that holds any ADK (Pair again, a device left behind by a rotation) is anchored on it, and recovery with the phrase is anchored; comparing pairing confirmation words out of band is not part of v1.

## 2. Clipboard events

How a signed-in device whose browser or app is added to the account and holds the ADK (§1.8) shares clipboard text with the account's other devices (PRD §7.1–§7.6). Version 1 carries text only. Endpoints, access levels, status codes, and rate limits are owned by `docs/API.md` §2.5 and `docs/SECURITY_MODEL.md` §5–§6; this section is the wire contract both sides implement. Web implements it in `web/src/features/clipboard/` (engine, store, capture, runtime) on top of `web/src/lib/crypto/`.

### 2.1 Event format

Each capture is one immutable event. Fields on the wire (JSON; binary fields base64url without padding, §1.10):

| Field | Set by | Meaning |
|---|---|---|
| `event_id` | client | UUID chosen by the capturing device, as lowercase canonical 8-4-4-4-12 hex text (§1.3); the idempotency key and, in exactly that text, part of the AAD. Any other form is rejected with `400` |
| `seq` | server | Per-account strictly increasing integer (§2.3) |
| `origin_device_id` | server | The device that posted it, taken from the verified token, never from the body |
| `event_type` | client | `TEXT` (the only value in v1) |
| `mime_type` | client | `text/plain` (the only value in v1) |
| `key_version` | client | ADK version whose `clipboard-v1` subkey encrypted it; must be the account's current version on create |
| `nonce` | client | 12 random bytes; `null` on a tombstone |
| `ciphertext` | client | AES-256-GCM ciphertext ‖ 16-byte tag; `null` on a tombstone |
| `payload_size` | client | UTF-8 byte length of the plaintext, 1…262,144. The server cannot read the plaintext, but in v1 it checks the declaration against the ciphertext: `len(ciphertext)` must equal `payload_size + 16` (`400` otherwise) |
| `created_at`, `expires_at` | server | Insert time; `created_at` + the account's `retention_days` at insert time. Microsecond precision: the server rounds both before the insert, so the `201` and every later read carry the same instants |
| `deleted` | server | `true` for a tombstone (deleted, cleared, or pushed out by the cap) |

Plaintext is the UTF-8 text exactly as read from the clipboard (no trimming, no normalization). Empty or whitespace-only text is never sent.

### 2.2 Encryption

Item encryption is §1.3 with id = `event_id`: AES-256-GCM under the `clipboard-v1` subkey of ADK(`key_version`), a fresh random 12-byte nonce per event, AAD = UTF-8 of `<event_id>|<key_version>` with `event_id` in its lowercase canonical text (§1.3). The plaintext is the UTF-8 text with no framing or padding, so `len(ciphertext) == payload_size + 16` (the GCM tag); the server rejects a create that breaks this with `400`. The shared vectors (`shared/protocol/schemas/clipboard-vectors.json`, `items`) fix one example. Writers always use the newest version they hold. A reader that lacks the row's version, or whose decryption fails (a ciphertext moved to another row, a relabelled version, any changed byte), shows the row as **locked on this device** and never shows other text; locked rows are retried when the device stores a version it did not hold (rotation pickup, pairing, recovery, chain import).

### 2.3 `seq` and cursors

- The server assigns `seq` inside the insert transaction while holding a per-account clipboard advisory lock (separate from history's), so `seq` order equals commit order and no reader can see seq n+1 before n. Deletions take a new `seq` too.
- A client's cursor is the highest `seq` it has applied. First use on a device (no cursor): `GET /v1/clipboard/history` returns the live events newest first and the account's highest `seq` from the same snapshot; the client stores both. Afterwards it follows `GET /v1/clipboard/events?cursor=<cursor>` page by page (`next_cursor` is the last `seq` returned) until a page is empty, applying each event in order: a live event is upserted, a tombstone removes the row. The cursor is stored only after the page is applied, in the same local transaction, and never moves backwards.
- Each `GET /v1/clipboard/events` records the `cursor` the caller sent as that device's applied position (`clipboard_device_cursors`). The final empty page therefore reports the device caught up.
- Tombstones are kept 7 days (§2.6). A device that has not caught up for longer than 6 days may have missed deletions, so it discards its cursor and reloads with `GET /v1/clipboard/history` instead of following an old cursor.
- Events past `expires_at` are left out by the server even before the sweep removes them; clients also hide expired rows they cached.

### 2.4 Idempotency, retries, and errors

- `POST /v1/clipboard/events` is idempotent on (account, `event_id`): a repeat returns the stored `seq`, `created_at`, `expires_at` with `201` and stores nothing new; re-posting a deleted event returns its tombstone `seq` and does not restore it. A client retries an unacknowledged event with the **same** `event_id`, so a lost response never duplicates an event.
- The server sends `CLIPBOARD_EVENT_CREATED` (§2.5) before it answers the create, so a client that fetches by cursor on that notification can see its own event before the `201` arrives. Seeing it there acknowledges the queued event, and the late `201` is plain success. A client never deletes an event because its acknowledgement arrived after the event left the queue; it sends `DELETE` again only for events deleted on that device (§2.9).
- `409 key_version_conflict`: the account rotated to a key this device has not picked up. The client runs a key check (rotation pickup, §1.13), re-encrypts the same plaintext under the newest held version with the same `event_id`, and retries once. A second conflict leaves the event queued and tells the user to pair this device again.
- `409 clipboard_paused`: nothing was stored; the client shows the paused state (§2.7) and keeps the event queued until sync resumes.
- `413 payload_too_large` or `400`: the server will never accept this event; the client drops it from its queue and says so. `429 rate_limited`: retried after `Retry-After`; reads (`GET /v1/clipboard/events`, `GET /v1/clipboard/history`) are rate limited too and a refused read is likewise retried after `Retry-After` (Web keeps showing the loading state or the cached timeline, not a load failure). A `DELETE` by a malformed id is `400`. Network errors and `5xx`: retried with backoff (Web: 5 s doubling to 60 s), on reconnect, and when the browser reports it is online again. `401`/`403` (the device left the account): the client stops; the account layer erases local data (§2.9).

### 2.5 WebSocket notifications

The server notifies every open socket of the account's devices that have a live **added** account session at send time, the origin device included, after each committed change (`shared/protocol/websocket-events.json`):

| Message | Payload | Client action |
|---|---|---|
| `CLIPBOARD_EVENT_CREATED` | `event_id, seq, origin_device_id, created_at, payload_size, key_version` | Fetch by cursor |
| `CLIPBOARD_EVENT_DELETED` | `event_id, seq` (also for a cap tombstone) | Fetch by cursor |
| `CLIPBOARD_HISTORY_CLEARED` | `seq` (highest tombstone) | Fetch by cursor |
| `CLIPBOARD_SETTINGS_UPDATED` | `paused, retention_days, sensitive_skip` | Apply (validated); refetch settings if malformed |
| `DEVICE_CONNECTED`, `DEVICE_DISCONNECTED` | `device_id` | Optional (Web refreshes device names for an unknown ID) |

Messages carry metadata only: no ciphertext and no plaintext ever goes over the WebSocket. Clients never apply an event from a notification; they always fetch with the cursor, which also covers missed notifications. They also fetch on (re)connect and, on the Web, when the tab regains focus or becomes visible. Bursts coalesce: a fetch requested while one runs causes at most one more pass. On the Web every open tab has its own socket and fetches for its own timeline, while the tabs of one browser share one cache and one stored cursor; a tab whose fetch finds that another tab already moved the stored cursor first reloads its timeline from the shared cache, so no event or tombstone is missed in any tab (§2.9).

### 2.6 Limits: size, cap, retention, rate

- Text only; `payload_size` ≤ 262,144 bytes of UTF-8 (256 KB), checked by the client before encryption and by the server (`413`); ciphertext ≤ 262,160 bytes and exactly `payload_size + 16` bytes (§2.2, `400` otherwise).
- At most 100 live events per account: inserting the 101st tombstones the oldest live one in the same transaction.
- Retention: `retention_days` 1…7 (default 7) applies to events created afterwards (`expires_at` at insert). The server's maintenance loop hard-deletes events past `expires_at` and tombstones older than 7 days. Clients hide expired rows and show the limit ("Kept for 7 days or 100 items").
- Creation: 60 per minute per device and 240 per minute per account (`429`); deletions, clear, and settings changes: 600 per minute per device; reads (`GET /v1/clipboard/events` and `GET /v1/clipboard/history`, one shared budget): 600 per minute per device (`docs/SECURITY_MODEL.md` §5).

### 2.7 Pause

`paused` is an account-wide setting (`PUT /v1/clipboard/settings`). While it is true: the server answers `409 clipboard_paused` to new events and stores nothing; reads, deletions, clear, and settings still work. Clients read and send nothing (manual Sync says "Resume sync first"), automatic capture stops on every device, and events already queued wait until sync resumes. Resuming on any device reaches the others through `CLIPBOARD_SETTINGS_UPDATED`.

### 2.8 Sensitive content

When the account setting `sensitive_skip` is true (default), clients run best-effort heuristics on the plaintext before anything is encrypted or sent, entirely on the device:

- **Platform flags** (where the platform has them): Android `ClipDescription.EXTRA_IS_SENSITIVE`, iOS `detectPatterns(for:)` before reading (Phases 6 and 7). Browsers expose no such flag.
- **Heuristics** (Web `web/src/features/clipboard/sensitive.ts`, in this order): a PEM private key block anywhere (`-----BEGIN … PRIVATE KEY-----`, including PGP private key blocks); a JSON Web Token anywhere (`eyJ….eyJ….…`); a well-known credential prefix anywhere (AWS `AKIA…`, Google `AIza…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox?-…`, Stripe `sk_live_…`/`sk_test_…`, `sk-…`); the whole text is a one-time code (4–8 digits, or two groups of 3–4 digits); the whole text is a Luhn-valid 13–19-digit card number; the whole text is one 24–512-character token without spaces that is not a URL (hex of 32+ characters with entropy ≥ 3 bits/char, or 3+ character classes with entropy ≥ 4 bits/char); the whole text is one 8–64-character word mixing lower, upper, digits, and symbols.
- **Automatic and in-page captures** that match are skipped silently and noted in the timeline on this device only ("Skipped — looked like a password or one-time code. Not synced."); the text is never stored or sent, and the same text is not noted again on the next focus.
- **Manual Sync** that matches shows "Skipped as possibly sensitive" with the disclaimer and **Sync anyway** (sends it) or **Don't sync**.
- The UI states that the check is best-effort: it can miss secrets and flag ordinary text. With `sensitive_skip` false nothing is skipped.

### 2.9 Offline queue and local data

- A capture is encrypted first, then written to the offline queue, then sent; the queue keeps only the encrypted request fields (`event_id`, `key_version`, `nonce`, `ciphertext`, `payload_size`) and the capture time, never plaintext. Queued events show at the top of the timeline as **Queued** (decrypted in memory) and are sent in capture order, idempotently (§2.4), when the network returns. Before sending, a client checks that the event is still in the shared queue, so an event another tab of the same browser acknowledged, deleted, or cleared is not sent again. A tombstone pulled for an event that is still queued (it reached the server, the response was lost, and another device deleted it) drops it from the queue too, and an acknowledgement that arrives for an event already seen as a tombstone is not added to the timeline, so a retry never brings a deleted row back. On the Web the `201` is applied in one local transaction against the shared state: when the event is no longer in the shared queue (another tab acknowledged, deleted, or cleared it), has a pending delete, or the stored cursor already passed its `seq` without the row being cached (another tab pulled its tombstone), the row is neither cached nor shown from the acknowledgement and the client follows the cursor instead; otherwise it leaves the queue and, when its `seq` is beyond the stored cursor, enters the cache (a later tombstone has a higher `seq`, so the cursor brings it).
- **Deleting a queued event** (it may have reached the server, or reach it from a create still in flight in any tab): in one local transaction it leaves the queue and the cache and goes into the durable **pending deletes** (Web: `meta`, keyed by account, written under the same generation check as every other write). Only events in that list, or deleted on this page, are ever deleted again by the client. Its `DELETE /v1/clipboard/events/{event_id}` is sent at once and retried with the queue (same backoff, on reconnect and on reload, offline included) until it answers `204`, or `404` once a 2-minute grace period after the delete has passed. A `404` inside the grace period means the create may still land, so one last `DELETE` follows when it ends. A `400` (an id the server never accepts) also settles it, and a pulled tombstone confirms it. Until then the event is hidden even if a pull shows it live; a live sighting, or a late `201` for it, sends the `DELETE` again at once. Deleting a synced event is a plain `DELETE`: on failure the row stays and the user sees the error.
- **Clear history** sends nothing queued afterwards. When Clear is pressed, the client notes every event queued at that moment, in this tab and in the browser's shared queue (captures waiting in another tab); it then waits for a send in flight in this tab to finish and sends `DELETE /v1/clipboard/history`. On success, every noted event leaves the queue and becomes a pending delete due after the grace period: the server clear already tombstoned those that reached it, and the final `DELETE` catches a create that another tab still had in flight. A capture made after Clear was pressed, including while the clear waits for that send, is kept and sent after it. If the clear fails, the queue is kept and the error is shown.
- Web storage: IndexedDB `share-anywhere-clipboard` with stores `events` (the account's live events exactly as the server returned them: ciphertext only, so the timeline opens offline), `queue`, and `meta` (cursor, last catch-up time, generation token, and pending deletes), every record keyed by account. Never Web Storage: `storage.ts` holds only the per-browser automatic capture on/off preference. Decrypted text exists only in memory while the page is open.
- **Several tabs of one browser** share these stores, and each tab keeps its own timeline in memory together with the cursor that timeline is applied up to. A tab starts from the cache and the stored cursor read in one transaction. Each fetch first reads the stored cursor; when another tab moved it, the tab reloads its timeline (and the pending deletes, and which of its queued events are still in the shared queue) from the cache and cursor, read together, and fetches on from there. A fetched page is written to the cache together with the new cursor in one transaction, and only when the stored cursor still equals the cursor the page was fetched from; when another tab wrote first, nothing is written and the tab reloads from the shared state and fetches on from its cursor. The stored cursor therefore only moves forward and the cache always holds every change up to it: no tab writes a stale page over a newer one, and a tab never misses an event or tombstone that another tab fetched. Rows enter the cache only from such a page, from the initial history load (not over a newer stored cursor), or from an acknowledgement whose `seq` is beyond the stored cursor; removals (local deletes, Clear) may be written at any time.
- Sign-out, revocation, an ended account session, or a key wipe erase the clipboard store together with the key store and sync bookkeeping (`wipeAccountData`), and the running clipboard runtime stops at once. Every wipe writes a new random generation token into `meta` in the same transaction that clears the stores; a runtime reads the token when it starts, and every later write checks it inside its own write transaction and writes nothing when it changed. A runtime still running in another tab of the same browser therefore cannot write ciphertext, a queued event, or a cursor back after any tab wiped.

### 2.10 Web capture rules and browser constraints

What a website can and cannot do (PRD §7.2), and what the Web client does:

- **Only for a ready account.** The capture code (`web/src/features/clipboard/capture.ts`, the only module that touches `navigator.clipboard`, the clipboard-read permission, or the page `copy` event) is imported only by the clipboard runtime, which the app loads with a dynamic import once the account is signed in, the device is added, and the key is on the device. A guest, a device that is not added, and a device without the key make no clipboard call, no permission query, and register no copy listener (enforced by a source-structure test and by Playwright instrumentation).
- **Secure context required.** On plain HTTP browsers offer neither the clipboard API nor WebCrypto; Clipboard shows "HTTPS required" and nothing else works.
- **Manual Sync** calls `navigator.clipboard.readText()` directly in the click handler (user gesture). Where the browser shows its own Paste UI (Firefox, Safari) or asks for permission (Chromium), that is the browser's prompt, answered by the user. If the read is refused, unsupported, or still pending after 4 s, a paste field opens (Ctrl+V, ⌘V, or long-press → Paste): pasted text is captured from the field. The browser is never asked again until the next click, so there is no prompt loop.
- **Automatic capture** (per-browser toggle, default on) reads opportunistically on window `focus` and `visibilitychange` (visible) only when `navigator.permissions.query({name: 'clipboard-read'})` already reports `granted`. `permissions.query` never prompts; where the browser does not expose that permission (Firefox, Safari) automatic capture is not attempted. Never polling, never on a timer. Offline it still reads and queues.
- **In-page copies**: only while the capture status (below) is `auto` or `besteffort` with the toggle on (secure context, the browser exposes the clipboard-read permission and has not denied it, sync not paused; offline they are still captured and queued, like automatic reads), the `copy` event of this page captures the selected text (or the field selection, or data the page set) of copies made inside Share Anywhere. Copies made in other apps are invisible to a website while it is not in front; the UI never claims otherwise. When the panel says capture is manual (`unsupported`, `denied`, the toggle off) or `paused`, in-page copies are not captured either, so the page never does more than the panel states.
- **Dedupe**: identical consecutive text is not sent twice (the newest row already holds it, or this tab already saw it, including text it wrote with Copy).
- **Copy** writes with `navigator.clipboard.writeText()` from the click; if that is missing or refused it falls back to selecting a hidden field and `document.execCommand('copy')` (not captured again); if both fail, the item drawer selects the text and says to press Ctrl+C. Nothing is ever written to the clipboard without a click (no automatic remote write).
- **Status**: the capture status panel (`clipboardStatus`, `docs/UX_SCREEN_MAP.md` §12) is derived from capability detection only: `insecure` (no secure context), `paused`, `offline`, `denied` (permission denied), `unsupported` (no `readText`, or no clipboard-read permission state: manual only), `auto` (granted and toggle on), `besteffort` (otherwise).

### 2.11 Revocation and key versions

Revoking a device ends its account session at once (no reads, `401`/`403`) and rotates the ADK without it (§1.8, §1.13). A new event must use the account's current `key_version` (§2.4), so every event created after the rotation is encrypted under a version the revoked device never received. It keeps whatever it already decrypted and the old versions it held; the Web client erases both when it notices the session ended.

### 2.12 Conformance

Android (Phase 6) and iOS (Phase 7) implement §2.1–§2.9 unchanged, with their platform capture rules (PRD §7.3, §7.3b) in place of §2.10, and must decrypt events written by the Web client (`clipboard-cross-client` nightly job, `docs/TESTING_AND_CI.md` §2.2).

---

*This document is frozen for `clipboard-protocol-v1`. Changes to §1 or §2 that alter the wire format, the encryption, or the cursor rules need a new protocol version and an ADR.*
