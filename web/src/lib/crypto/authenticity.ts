import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ADK_BYTES } from './adk';
import { CryptoError, invalid } from './errors';
import {
  assertLength,
  assertVersion,
  b64uDecode,
  b64uEncode,
  copyBytes,
  equalBytes,
  utf8,
  zeroize,
  type Bytes,
} from './encoding';
import { hkdfBase, hkdfBytes, subtle } from './primitives';
import type { KeyStore } from './store';
import { unwrapChain } from './wrap';

/**
 * Key authenticity (docs/CLIPBOARD_PROTOCOL.md §1 "Key authenticity", ADR 0012). Every ADK version v has an Ed25519
 * signing key only its holders can derive:
 *   sign_seed(v)  = HKDF-SHA256(ikm = ADK(v), salt = empty, info = "sa-keyver-sign-v1", 32 bytes)
 *   verify_key(v) = Ed25519 public key of sign_seed(v) (RFC 8032, pure)
 * The server stores verify_key(v) per version. A rotation to v+1 is signed with version v; a device wrapping key is
 * registered with a proof made by a version the device holds; the first verify key is anchored to the recovery
 * phrase with an HMAC only a phrase holder can compute. Clients verify all of it, so a server (or an added device
 * that knows only the password) cannot slip its own ADK into the account.
 */
export const SIGN_INFO = 'sa-keyver-sign-v1';
export const ANCHOR_INFO = 'sa-recovery-anchor-v1';
export const VERIFY_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const ANCHOR_BYTES = 32;

const EMPTY_SALT = new Uint8Array(0);

/** sign_seed(v) from raw ADK bytes. Transient: zeroize it. */
export async function signSeed(adkRaw: Uint8Array): Promise<Bytes> {
  assertLength(adkRaw, ADK_BYTES, 'ADK');
  return hkdfBytes(adkRaw, EMPTY_SALT, SIGN_INFO);
}

/** verify_key(v) of raw ADK bytes. */
export async function verifyKeyOf(adkRaw: Uint8Array): Promise<Bytes> {
  const seed = await signSeed(adkRaw);
  try {
    return copyBytes(ed25519.getPublicKey(seed));
  } finally {
    zeroize(seed);
  }
}

/** Ed25519 signature by version v's signing key (derived from the raw ADK, erased right after). */
export async function signWithAdk(adkRaw: Uint8Array, message: Uint8Array): Promise<Bytes> {
  const seed = await signSeed(adkRaw);
  try {
    return copyBytes(ed25519.sign(message, seed));
  } finally {
    zeroize(seed);
  }
}

/** Strict RFC 8032 verification (no ZIP-215 leniency); malformed inputs are simply invalid. */
export function verifySignature(signature: Uint8Array, message: Uint8Array, verifyKey: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_BYTES || verifyKey.length !== VERIFY_KEY_BYTES) return false;
  try {
    return ed25519.verify(signature, message, verifyKey, { zip215: false });
  } catch {
    return false;
  }
}

/** `"sa-rotate-v1|" + (v+1) + "|" + b64u(verify_key(v+1)) + "|" + b64u(SHA-256(chain_blob))` (contract A.3). */
export function rotationMessage(keyVersion: number, verifyKey: Uint8Array, chainBlob: Uint8Array): string {
  assertVersion(keyVersion);
  if (keyVersion < 2) throw invalid('a rotation signature exists only for key_version >= 2');
  assertLength(verifyKey, VERIFY_KEY_BYTES, 'verify key');
  return `sa-rotate-v1|${keyVersion}|${b64uEncode(verifyKey)}|${b64uEncode(sha256(chainBlob))}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `"sa-devkey-v1|" + <device id, lowercase canonical UUID> + "|" + key_version + "|" + b64u(public_key)` (A.4). */
export function deviceKeyMessage(deviceId: string, keyVersion: number, publicKey: Uint8Array): string {
  const id = deviceId.toLowerCase();
  if (!UUID.test(id)) throw invalid('device id must be a canonical UUID');
  assertVersion(keyVersion);
  assertLength(publicKey, 32, 'device public key');
  return `sa-devkey-v1|${id}|${keyVersion}|${b64uEncode(publicKey)}`;
}

/**
 * `"sa-recoverykey-v1|" + b64u(recovery_public_key)` (contract H.1): signed at setup by version 1 so a rotating device
 * can check, with the verify_key(1) it derives from its own ADK(1), that the recovery public key the server returns is
 * the one the account was set up with (docs/ADR/0015-authenticated-recovery-key.md).
 */
export function recoveryKeyMessage(recoveryPublicKey: Uint8Array): string {
  assertLength(recoveryPublicKey, 32, 'recovery public key');
  return `sa-recoverykey-v1|${b64uEncode(recoveryPublicKey)}`;
}

/** `recovery_key_signature` of setup: Ed25519 by ADK(1)'s signing key over {@link recoveryKeyMessage}. */
export async function recoveryKeySignature(adkV1Raw: Uint8Array, recoveryPublicKey: Uint8Array): Promise<Bytes> {
  return signWithAdk(adkV1Raw, utf8(recoveryKeyMessage(recoveryPublicKey)));
}

/**
 * Throws unless `signature` (`recovery.signature` of `GET /v1/keys`) is a valid signature by `verifyKeyV1` over the
 * recovery public key `publicKey` (base64url). `null` is a legacy account set up before the signature existed
 * (`keys_legacy`); anything else that does not verify, including a missing or malformed field, is `unverified`.
 */
export function assertRecoveryKeySigned(
  publicKey: string,
  signature: string | null | undefined,
  verifyKeyV1: Uint8Array,
): void {
  if (signature === null) {
    throw new CryptoError(
      'keys_legacy',
      'the recovery key predates its signature: the account keys must be set up again',
    );
  }
  if (typeof signature !== 'string') throw unverified('the recovery key is not signed');
  let message: Uint8Array;
  let sig: Bytes;
  try {
    message = utf8(recoveryKeyMessage(b64uDecode(publicKey)));
    sig = b64uDecode(signature);
  } catch {
    throw unverified('malformed recovery key or signature');
  }
  if (!verifySignature(sig, message, verifyKeyV1)) {
    throw unverified('the recovery key is not signed by the first account key version');
  }
}

/** `"sa-anchor-v1|" + b64u(verify_key(1))` (A.2). */
export function anchorMessage(verifyKeyV1: Uint8Array): string {
  assertLength(verifyKeyV1, VERIFY_KEY_BYTES, 'verify key');
  return `sa-anchor-v1|${b64uEncode(verifyKeyV1)}`;
}

/**
 * HMAC-SHA256 key of the recovery anchor, HKDF(ikm = recovery_seed, info = "sa-recovery-anchor-v1"), derived straight
 * into a non-extractable WebCrypto key so the caller can erase the seed at once.
 */
export async function anchorKeyFromSeed(recoverySeed: Uint8Array): Promise<CryptoKey> {
  assertLength(recoverySeed, 32, 'recovery seed');
  const params = { name: 'HKDF', hash: 'SHA-256', salt: EMPTY_SALT, info: utf8(ANCHOR_INFO) };
  return subtle().deriveKey(
    params,
    await hkdfBase(recoverySeed),
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/** Raw anchor key bytes: test vectors only. */
export async function anchorKeyBytes(recoverySeed: Uint8Array): Promise<Bytes> {
  assertLength(recoverySeed, 32, 'recovery seed');
  return hkdfBytes(recoverySeed, EMPTY_SALT, ANCHOR_INFO);
}

/** recovery_anchor = HMAC-SHA256(anchor key, anchorMessage(verify_key(1))). */
export async function recoveryAnchor(anchorKey: CryptoKey, verifyKeyV1: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().sign('HMAC', anchorKey, utf8(anchorMessage(verifyKeyV1))));
}

/** `{key_version, verify_key, signature}` of `GET /v1/keys/chain` `versions` (A.5). */
export interface KeyVersionInfo {
  key_version: number;
  /** Null only for a legacy row created before key authenticity (refused by every check). */
  verify_key: string | null;
  signature: string | null;
}

/** `GET /v1/keys/chain` (A.5). */
export interface ChainState {
  chain: readonly { key_version: number; blob: string }[];
  versions: readonly KeyVersionInfo[];
}

function unverified(message: string): CryptoError {
  return new CryptoError('unverified', message);
}

function legacy(): CryptoError {
  return new CryptoError('keys_legacy', 'the account keys predate key authenticity and must be set up again');
}

/** verify_key(k) from the version list; a missing row is unverified, a legacy row (null) is `keys_legacy`. */
export function versionVerifyKey(versions: readonly KeyVersionInfo[], keyVersion: number): Bytes {
  const row = versions.find((r) => r.key_version === keyVersion);
  if (!row) throw unverified(`no verify key for version ${keyVersion}`);
  if (row.verify_key === null) throw legacy();
  let key: Bytes;
  try {
    key = b64uDecode(row.verify_key);
  } catch {
    throw unverified(`malformed verify key for version ${keyVersion}`);
  }
  if (key.length !== VERIFY_KEY_BYTES) throw unverified(`malformed verify key for version ${keyVersion}`);
  return key;
}

function chainBlob(state: ChainState, keyVersion: number): Bytes {
  const link = state.chain.find((l) => l.key_version === keyVersion);
  if (!link) throw unverified(`no chain link for version ${keyVersion}`);
  try {
    return b64uDecode(link.blob);
  } catch {
    throw unverified(`malformed chain link for version ${keyVersion}`);
  }
}

/**
 * Checks that every rotation 2..upTo was signed by the version before it: `versions[k].signature` over
 * {@link rotationMessage}(k, verify_key(k), chain[k]) with verify_key(k-1). Throws `unverified` (or `keys_legacy`).
 * Version 1 is trusted by the caller's own means (the recovery anchor, or the ADK it already holds).
 *
 * With `from` (contract F.1), the walk starts at version `from.keyVersion` with `from.verifyKey`, a verify key the
 * caller derived from an ADK it holds, and checks only `from.keyVersion + 1 .. upTo`: rows below it are never read,
 * so a server cannot replace history the device already knows.
 */
export function verifySignatureChain(
  state: ChainState,
  upTo: number,
  from?: { keyVersion: number; verifyKey: Uint8Array },
): void {
  assertVersion(upTo);
  const start = from?.keyVersion ?? 1;
  assertVersion(start);
  if (start > upTo) throw unverified(`version ${upTo} is older than the held version ${start}`);
  let previous = from ? copyBytes(from.verifyKey) : versionVerifyKey(state.versions, 1);
  if (previous.length !== VERIFY_KEY_BYTES) throw invalid('verify key must be 32 bytes');
  for (let k = start + 1; k <= upTo; k++) {
    const current = versionVerifyKey(state.versions, k);
    const row = state.versions.find((r) => r.key_version === k);
    if (!row?.signature) throw row?.signature === null ? legacy() : unverified(`version ${k} is unsigned`);
    let signature: Bytes;
    try {
      signature = b64uDecode(row.signature);
    } catch {
      throw unverified(`malformed signature for version ${k}`);
    }
    const message = utf8(rotationMessage(k, current, chainBlob(state, k)));
    if (!verifySignature(signature, message, previous))
      throw unverified(`version ${k} is not signed by version ${k - 1}`);
    previous = current;
  }
}

/**
 * Anchors a server-supplied account on the keys this device already holds (contract F.1), before a received ADK(v)
 * is stored as the newest version (pairing receive, recovery). With no ADK held it does nothing: the caller's own
 * rule applies (for pairing, unanchored: docs/CLIPBOARD_PROTOCOL.md §1.13). Otherwise, with k the highest held
 * version, every check below must pass or it throws `unverified` and nothing may be stored:
 * - v >= k (the server cannot roll the device back);
 * - every held ADK(h) derives `versions[h].verify_key` (constant-time compare);
 * - the rotations k+1..v are signed starting from the held verify_key(k) (versions below k are never trusted);
 * - opening the chain from the received ADK(v) down to k yields exactly the held ADK(k) (byte equality; for v = k
 *   the received key itself must equal it).
 */
export async function assertAnchoredOnHeld(
  store: KeyStore,
  state: ChainState,
  keyVersion: number,
  received: Uint8Array,
): Promise<void> {
  assertVersion(keyVersion);
  const held = await store.allVersions();
  if (held.length === 0) return;
  const k = Math.max(...held);
  if (keyVersion < k) throw unverified(`version ${keyVersion} is older than the held version ${k}`);
  let heldTop: Bytes | null = null;
  let walked: Bytes | null = null;
  try {
    let topVerifyKey: Bytes | null = null;
    for (const h of held) {
      const raw = await store.unwrapAdkRaw(h);
      try {
        const own = await verifyKeyOf(raw);
        if (!equalBytes(own, versionVerifyKey(state.versions, h))) {
          throw unverified(`held ADK version ${h} does not match the account's verify key`);
        }
        if (h === k) {
          topVerifyKey = own;
          heldTop = copyBytes(raw);
        }
      } finally {
        zeroize(raw);
      }
    }
    if (!topVerifyKey || !heldTop) throw unverified(`held ADK version ${k} is missing`);
    verifySignatureChain(state, keyVersion, { keyVersion: k, verifyKey: topVerifyKey });
    walked = copyBytes(received);
    for (let j = keyVersion; j > k; j--) {
      let next: Bytes;
      try {
        next = await unwrapChain(chainBlob(state, j), walked, j);
      } catch (cause) {
        if (cause instanceof CryptoError && cause.code === 'unverified') throw cause;
        throw new CryptoError('unverified', `chain link ${j} does not open toward the held key`, { cause });
      }
      zeroize(walked);
      walked = next;
    }
    if (!equalBytes(walked, heldTop)) throw unverified(`the received key does not lead to held version ${k}`);
  } finally {
    zeroize(heldTop, walked);
  }
}

/** Throws `unverified` unless the raw ADK derives `versions[keyVersion].verify_key` (constant-time compare). */
export async function assertAdkMatchesVersion(
  adkRaw: Uint8Array,
  versions: readonly KeyVersionInfo[],
  keyVersion: number,
): Promise<void> {
  const expected = versionVerifyKey(versions, keyVersion);
  if (!equalBytes(await verifyKeyOf(adkRaw), expected)) {
    throw unverified(`ADK version ${keyVersion} does not match the account's verify key`);
  }
}

/**
 * Rotation pickup rule (A.6): a candidate ADK(v) is genuine when the chain link of version v, opened with it, yields
 * the ADK(v-1) this device already holds, and it derives `versions[v].verify_key`. Only a holder of ADK(v-1) can make
 * such a link, so a device that knows only the password cannot.
 */
export async function assertRotationLink(
  candidate: Uint8Array,
  heldPrevious: Uint8Array,
  state: ChainState,
  keyVersion: number,
): Promise<void> {
  if (keyVersion < 2) throw unverified('a rotation exists only for key_version >= 2');
  let opened: Bytes | null = null;
  try {
    try {
      opened = await unwrapChain(chainBlob(state, keyVersion), candidate, keyVersion);
    } catch (cause) {
      if (cause instanceof CryptoError && cause.code === 'unverified') throw cause;
      throw new CryptoError('unverified', `chain link ${keyVersion} does not open with the new key`, { cause });
    }
    if (!equalBytes(opened, heldPrevious)) throw unverified(`chain link ${keyVersion} does not lead to the held key`);
  } finally {
    zeroize(opened);
  }
  await assertAdkMatchesVersion(candidate, state.versions, keyVersion);
}

/** `PUT /v1/keys/device` body (A.4). */
export interface DeviceKeyRegistration {
  public_key: string;
  key_version: number;
  proof: string;
}

/** A device key registration proven by ADK `keyVersion` (raw bytes; the caller erases them). */
export async function deviceKeyProof(
  adkRaw: Uint8Array,
  keyVersion: number,
  deviceId: string,
  publicKey: Uint8Array,
): Promise<DeviceKeyRegistration> {
  const proof = await signWithAdk(adkRaw, utf8(deviceKeyMessage(deviceId, keyVersion, publicKey)));
  return { public_key: b64uEncode(publicKey), key_version: keyVersion, proof: b64uEncode(proof) };
}

/** True when `proof` is a valid device key proof for `deviceId` / `publicKey` under `verifyKey`. */
export function checkDeviceKeyProof(
  verifyKey: Uint8Array,
  deviceId: string,
  keyVersion: number,
  publicKey: string,
  proof: string,
): boolean {
  try {
    const message = utf8(deviceKeyMessage(deviceId, keyVersion, b64uDecode(publicKey)));
    return verifySignature(b64uDecode(proof), message, verifyKey);
  } catch {
    return false;
  }
}
