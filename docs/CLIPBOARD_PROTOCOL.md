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

- Each added device creates an X25519 keypair once. It registers the public key with `PUT /v1/keys/device` only once it holds the ADK (after setup, pairing, or recovery), with a proof made by the newest ADK version it holds, which must be the account's current version (§1.13); never right after "Add this device". It registers again whenever it holds a newer version than its registration (after a pickup, rotation, pairing, recovery, or chain import). Rotation blobs are wrapped to it; for pairing it is the existing device's sender key.
- Web: a WebCrypto X25519 key with a non-extractable private key, kept in IndexedDB as a `CryptoKey` (Chrome 133+, Firefox 130+, Safari 17+). Browsers without WebCrypto X25519 (for example Safari 16) fall back to `@noble/curves`; the private scalar is then script-visible while in use and is stored encrypted under the device KEK (§1.9). Both backends produce identical bytes (`clipboard-vectors.json`).
- Android and iOS: the private key is wrapped by a Keystore or Secure Enclave key (§1.9).
- A device that has not registered a public key proven by the current version (for example one that was added but never paired, or one left behind at an older version) receives no rotation blob; it pairs again or uses the phrase.

### 1.8 Flows

**Setup (first device).** After sign-up or the first sign-in of an account with `key_version = 0`, the device generates ADK v1, a phrase, and a salt, derives the recovery keypair and the anchor key from the same Argon2id seed (then erases the seed), wraps ADK v1 to the recovery key, and sends `POST /v1/keys/setup {recovery_public_key, salt, params, recovery_blob, verify_key, recovery_anchor}` (§1.13). It stores ADK v1 locally only after `201`, then registers its device key with a proof by version 1. On `409 keys_exist` another device won; this one discards its ADK and pairs or recovers instead. The phrase screen comes next and cannot be revisited.

**Pairing (new device, both devices signed in and added).**

1. The new device creates an ephemeral keypair and calls `POST /v1/keys/pairings {ephemeral_public_key}` → `{pairing_id, code, expires_at}` (10 minutes).
2. It shows a QR code and the same text to paste: `sa1.<code>.<fingerprint>`, where fingerprint = base64url of the first 16 bytes of SHA-256(ephemeral public key).
3. The existing device scans or pastes it, calls `GET /v1/keys/pairings/by-code/{code}`, and refuses to continue unless the returned `ephemeral_public_key` matches the fingerprint. It should show the returned `device_name` for the user to confirm.
4. It wraps its newest ADK to the ephemeral key with its device key (purpose `pair`) and sends `POST /v1/keys/pairings/by-code/{code}/wrap {key_version, sender_public_key, blob}`.
5. The new device polls `GET /v1/keys/pairings/{pairing_id}` until `ready`, checks that `sender_public_key` is one of the account's registered device keys (`GET /v1/keys` `devices`) and that the blob is wrapped by it, unwraps, and verifies the ADK against `GET /v1/keys/chain` (§1.13 "Pairing receive") before storing it. It then imports the chain (§1.5) and registers its own device key with a proof.

The fingerprint closes the gap where a dishonest server swaps in its own ephemeral key for the code: the existing device would wrap the ADK to a key the server holds.

**Recovery (new device, phrase).** `GET /v1/keys/recovery` → `{key_version, recovery_blob, salt, params, recovery_anchor}` and `GET /v1/keys/chain`; the device validates the phrase, derives the recovery keypair and anchor key, unwraps (purpose `recovery`), verifies the anchor, the signature chain, and the verify key (§1.13 "Recovery"), then stores the ADK, imports the chain, and registers its device key with a proof. A well-formed but wrong phrase fails as a decryption error; the screen says the phrase does not match. A right phrase whose account does not verify stores nothing and says so.

**Rotation (after revoking a device, or when one is owed).** The revoking device calls `DELETE /v1/devices/{id}`, then `GET /v1/keys`. If its newest local version is behind `key_version`, it first accepts its pending blobs. It then generates ADK(v+1) and sends `POST /v1/keys/rotate` with:

- `chain_blob`: ADK(v) under ADK(v+1) (§1.5);
- `recovery_blob`: ADK(v+1) wrapped to the recovery public key, so the phrase keeps working without being re-entered;
- `device_blobs`: ADK(v+1) wrapped (purpose `rotate`) to every remaining added device whose registered public key carries a proof by the current version v that verifies with the rotating device's own ADK(v) (§1.13), the rotating device included as a safety copy, and never to the device just revoked (`exclude`), whatever the server lists;
- `verify_key` and `signature`: verify_key(v+1) and the rotation signed with version v (§1.13).

It stores ADK(v+1) only after `200`. On `409 key_version_conflict` or `409 devices_changed` (body `{missing, unexpected}`: devices that should have had a blob, and blobs the server does not want) it discards the new ADK, refreshes `GET /v1/keys` (picking up pending blobs and re-proving), and tries once more with the refreshed device list. `403 rotation_unauthorized` (the signature does not verify against the stored verify_key(v)), and a conflict that persists after the retry, are this device's own update being refused: the key state becomes `refused` ("This device couldn't update your account keys", with Pair again and Use recovery phrase), distinct from a rejected incoming change. `409 keys_legacy` (keys from before §1.13) is shown as legacy keys. Any other failure leaves the rotation owed (below). The revoked device keeps the versions it already had (old entries it could read before), but it receives no blob for v+1 and loses API access with its account session, so it cannot read anything written afterwards; signing in again with the password and a kept ADK(v) does not help, because a device key proven by an old version is refused (§1.13).

**Rotation owed.** Whenever an added device that has a registered device key leaves the account by any path (revoked, signed out, password reset or change, refresh secret reuse, expiry, identity reset), the server sets `rotation_due` in `GET /v1/keys` in the same transaction; a successful rotation clears it. On every key check, a device that holds the current version and sees `rotation_due = true` rotates as above with an empty `exclude`. If that fails (offline, a race that did not settle), the server still says `rotation_due`, so the next key check (the next load, or Retry on Devices) tries again, and Devices shows that new keys could not be sent yet. A device that is not ready leaves it to one that is.

**Pending pickup.** Each device reads `pending` from `GET /v1/keys` when it starts an account session and whenever it finds a newer `key_version` than it holds, unwraps each blob (purpose `rotate`, version bound by the AAD), verifies it (§1.13 "Rotation pickup"), stores it, acknowledges with `DELETE /v1/keys/pending/{key_version}`, and re-proves its device key with the new version. A blob that does not verify is neither stored nor acknowledged, and the UI shows "A key change on your account could not be verified" with Pair again and Use recovery phrase. Storing the same bytes twice is a no-op; different bytes for a stored version are refused.

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
- **Dishonest server.** It can withhold or reorder data and refuse service, but it cannot read content: it cannot substitute a pairing key (fingerprint check), forge a pairing blob from an unknown sender (sender check against registered device keys and the blob prefix), move a ciphertext between rows or versions (AAD), replay a blob for another purpose or version (AAD), get a rotation blob wrapped to a key of its own (device keys need a proof made with the current ADK, §1.13), make existing devices adopt an ADK it chose (rotation pickup needs a chain link to the held key, and pairing or recovery on a device that holds an ADK is anchored on the held keys, §1.13), or make a device drop its keys by claiming the account has no key or an older one (the device keeps its keys and shows the key problem). Residual risk: pairing receive on a device holding no ADK is not anchored (§1.13).
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
- `key_authenticity` (generated by the Go backend from the `chain` inputs): signing seeds and verify keys for ADK v1 and v2, the rotation message and signature for version 2, a device key message and proof, and the anchor key, message, and recovery anchor from a fixed seed. `web/src/lib/crypto/authenticity-vectors.test.ts` and the Go test both verify every value.

`web/src/lib/crypto/vectors.test.ts` regenerates (`UPDATE_VECTORS=1`) and compares it with both X25519 backends. Change it only together with a format version bump. Fixed nonces and keys exist only for vectors; production code always draws fresh randomness.

Web modules (`web/src/lib/crypto/`): `adk.ts` (ADK, subkeys), `item.ts` (item encryption, wire helpers), `wrap.ts` (ECIES and chain), `phrase.ts`, `argon.ts`, `recovery.ts`, `recovery.worker.ts` (phrase and recovery key), `x25519.ts` and `device-key.ts` (X25519 backends, device key), `store.ts` (IndexedDB key store), `authenticity.ts` (version signing keys, proofs, anchor, verification rules), `bootstrap.ts`, `pairing.ts`, `rotation.ts` (flows). Account screens load the library lazily so it stays out of the main bundle.

### 1.13 Key authenticity

Wrapping alone says nothing about who chose a key: any added device, including one whose user only knows the password, could otherwise post `POST /v1/keys/rotate` with an ADK it chose, and every device would accept a rotation blob it can open (QA round 1 P0-1). Every ADK version therefore carries a signing key that only its holders can derive (ADR 0012, amended by ADR 0014; endpoints in `docs/API.md`). Ed25519 is RFC 8032 (pure, deterministic; Web verifies strictly, without ZIP-215 leniency); HKDF is HKDF-SHA256 with an empty salt; `b64u` is base64url without padding; `|` is a literal separator and numbers are decimal.

```text
sign_seed(v)    = HKDF(ikm = ADK(v), info = "sa-keyver-sign-v1", L = 32)
verify_key(v)   = Ed25519 public key of sign_seed(v)                                   (32 bytes, stored per version)
rotation sig    = Ed25519_sign(sign_seed(v),   "sa-rotate-v1|" + (v+1) + "|" + b64u(verify_key(v+1)) + "|" + b64u(SHA-256(chain_blob)))
device proof    = Ed25519_sign(sign_seed(kv),  "sa-devkey-v1|" + <device id, lowercase UUID> + "|" + kv + "|" + b64u(public_key))
anchor key      = HKDF(ikm = recovery_seed, info = "sa-recovery-anchor-v1", L = 32)  (recovery_seed = the Argon2id output of §1.6)
recovery_anchor = HMAC-SHA256(anchor key, "sa-anchor-v1|" + b64u(verify_key(1)))
```

Server checks: setup requires `verify_key` and `recovery_anchor`; a rotation must be signed by the stored verify_key(v) (`403 rotation_unauthorized`, nothing stored); a device key registration (`{public_key, key_version, proof}`) must name the account's current version (`409 key_version_conflict` otherwise, nothing stored) and carry a proof by it for the caller's device ID from the token (`403 device_key_unproven`); a rotation from v to v+1 must carry a blob for exactly the other added devices whose registered proof is by version v (the caller may add a safety copy for itself), otherwise `409 devices_changed` with `{missing, unexpected}`; devices with an older proof get nothing and must pair again; accounts created before key authenticity have no verify key and are refused (`409 keys_legacy`). `GET /v1/keys` carries `rotation_due` (§1.8 "Rotation owed"), `GET /v1/keys/chain` returns `{chain, versions: [{key_version, verify_key, signature}]}`, and `GET /v1/keys/recovery` adds `recovery_anchor`.

Client rules (Web: `web/src/lib/crypto/authenticity.ts`, `rotation.ts`, `bootstrap.ts`, `pairing.ts`; comparisons of key material are constant-time):

- **Rotation pickup** (`acceptPendingBlobs`): versions ascending. A blob for version v is accepted only when the device already holds ADK(v-1), the chain link of v opened with the candidate yields exactly that ADK(v-1), and the candidate derives `versions[v].verify_key`. Only a holder of ADK(v-1) can make such a link. Otherwise nothing is stored or acknowledged and the key state becomes `rejected`.
- **Rotating** (`prepareRotation`): a device gets a blob only when its proof is by the current version v and verifies with verify_key(v) derived from the rotating device's own ADK(v). Others are skipped: `no_key` (nothing registered), `stale` (a proof by an older version, such as a revoked laptop that kept ADK(v-1)), `unproven` (a proof that does not verify, is malformed, or claims a newer version), `excluded` (the device just revoked). The rotation is signed with version v. A rotation is also made, with nothing excluded, whenever the server says one is owed (§1.8).
- **Recovery** (`recoverWithPhrase`): the anchor recomputed from the phrase must authenticate `versions[1].verify_key`; each `versions[k].signature` (k = 2..v) must verify with `versions[k-1].verify_key` over the rotation message built from `chain[k]`; the recovered ADK(v) must derive `versions[v].verify_key`. Any failure is `recovery_unverified`; an account without an anchor is `keys_legacy`. The phrase is the root of trust, so recovery is fully anchored.
  When the device already holds an ADK, the account must also be consistent with it (the pairing rule below).
- **Pairing receive** (`acceptPairing`): the received ADK(v) must derive `versions[v].verify_key`. If the device holds no ADK, the signature chain 2..v must verify. If it holds any ADK, with k its highest held version, the account is anchored on the held keys (`assertAnchoredOnHeld`): v ≥ k; every held ADK(h) derives `versions[h].verify_key`; the signatures k+1..v verify starting from the held verify_key(k), so versions below k are never taken from the server; and opening the chain from the received ADK(v) down to k yields exactly the held ADK(k) (for v = k, the received key must equal it). Any failure stores nothing.
- **Registering the device key**: only once the device holds the ADK, with a proof by the newest version it holds (`proveDeviceKey`), and again whenever that version is newer than the `key_version` of its own registration in `GET /v1/keys` (or it has none). On `409 key_version_conflict` the device refreshes `GET /v1/keys`, picks up pending blobs, and retries once; a second conflict, or `403 device_key_unproven`, is `refused`.
- **No silent wipe**: when `GET /v1/keys` reports `key_version 0`, or a version lower than the highest held, for the same account, the device keeps its keys and shows the key problem (`rejected`). Keys are erased only on sign-out, when a different account signs in on the browser, or when the account session ends.

Limitation (pairing receive on a device holding no ADK): such a device has nothing of its own to anchor to. A dishonest server that controls everything the new device sees could present a whole fabricated account (its own versions, signatures, and a pairing blob from a device key of its own) and the checks above would pass. The pairing fingerprint protects the existing device's side only. A device that holds any ADK (Pair again, a device left behind by a rotation) is anchored on it, and recovery with the phrase is anchored; comparing pairing confirmation words out of band is not part of v1.

## 2. Clipboard events

*Placeholder: Phase 5B specifies the clipboard event protocol here (event format, `seq` cursors, idempotency, WebSocket notifications, size and retention limits, sensitive-content rules), using the `clipboard-v1` subkey and item encryption from §1.3.*
