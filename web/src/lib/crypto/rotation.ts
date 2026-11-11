import { generateAdk } from './adk';
import {
  assertRecoveryKeySigned,
  assertRotationLink,
  checkDeviceKeyProof,
  rotationMessage,
  signWithAdk,
  verifyKeyOf,
  verifySignature,
  versionVerifyKey,
  type ChainState,
} from './authenticity';
import { CryptoError, invalid } from './errors';
import { assertVersion, b64uDecode, b64uEncode, equalBytes, utf8, zeroize, type Bytes } from './encoding';
import type { KeyStore } from './store';
import { unwrapAdk, unwrapChain, wrapAdk, wrapChain } from './wrap';
import type { X25519KeyPair } from './x25519';

/**
 * Key rotation (PRD §7.5 "Revoking a device bumps key_version", contract §Keys `POST /v1/keys/rotate`, key
 * authenticity in docs/CLIPBOARD_PROTOCOL.md §1). The rotating device generates ADK(v+1), chains ADK(v) under it,
 * wraps it to the recovery public key and to every remaining added device whose key registration is proven by the
 * current version v (checked with this device's own ADK(v)), signs the rotation with version v, and stores ADK(v+1)
 * only after the server accepts. The recovery public key is used only once its setup signature verifies with the
 * verify_key(1) this device derives from its own ADK(1) (contract H.3), so a server cannot obtain new keys by listing a
 * recovery key of its own.
 */
export interface DeviceKeyInfo {
  device_id: string;
  public_key: string | null;
  /** The ADK version that proved the registration (contract A.4). */
  key_version?: number | null;
  /** Ed25519 proof by `key_version` over the device ID and public key. */
  proof?: string | null;
}

export interface RotateRequest {
  key_version: number;
  recovery_blob: string;
  chain_blob: string;
  device_blobs: { device_id: string; blob: string }[];
  /** verify_key(v+1). */
  verify_key: string;
  /** Ed25519 by version v over the rotation message (contract A.3). */
  signature: string;
}

/**
 * Why a device got no blob (contract D.3):
 * - `no_key`: it registered no wrapping key;
 * - `unproven`: its proof does not verify with this device's own ADK(v), or it is malformed or claims a newer version;
 * - `stale`: its proof is by an older version than v (a device that held only an old key, such as a revoked laptop
 *   whose ADK(v-1) leaked, must not get the new one; it re-proves with the current key or pairs again);
 * - `excluded`: the caller excluded it (the device just revoked).
 */
export type SkipReason = 'no_key' | 'unproven' | 'stale' | 'excluded';

export interface PreparedRotation {
  request: RotateRequest;
  /** Devices left without a blob, with the reason. They must pair again (or re-prove, for `stale`). */
  skipped: { device_id: string; reason: SkipReason }[];
  /** Store ADK(v+1) once the server answered 200. */
  commit(): Promise<void>;
  /** Drop ADK(v+1) after a refusal (409 key_version_conflict / devices_changed): fetch keys and retry. */
  discard(): void;
}

export interface RotationInput {
  /** `key_version` from `GET /v1/keys`; must equal the newest version this device holds. */
  serverKeyVersion: number;
  /** `recovery.public_key` from `GET /v1/keys`. */
  recoveryPublicKey: string;
  /**
   * `recovery.signature` from `GET /v1/keys`: by ADK(1) over the recovery public key (contract H.1). Null (legacy
   * account) refuses with `keys_legacy`; missing, malformed or not verifying refuses with `unverified`.
   */
  recoverySignature: string | null | undefined;
  /**
   * `devices` from `GET /v1/keys`. Every device whose key is proven by the current version gets a blob, this one
   * included: if storing locally fails after the server accepted, the device can still pick up its own pending blob.
   */
  devices: readonly DeviceKeyInfo[];
  /** Device IDs that never get a blob, whatever the server lists (the device just revoked). */
  exclude?: readonly string[];
}

/** Why `d` gets no blob, or null when its key is proven by the current version `v` (contract D.3). */
function skipReason(
  d: DeviceKeyInfo,
  v: number,
  verifyKey: Uint8Array,
  exclude: ReadonlySet<string>,
): SkipReason | null {
  if (exclude.has(d.device_id.toLowerCase())) return 'excluded';
  if (!d.public_key) return 'no_key';
  if (!d.proof || typeof d.key_version !== 'number' || !Number.isSafeInteger(d.key_version)) return 'unproven';
  if (d.key_version < v) return 'stale';
  if (d.key_version !== v) return 'unproven';
  return checkDeviceKeyProof(verifyKey, d.device_id, v, d.public_key, d.proof) ? null : 'unproven';
}

/**
 * Contract H.3: the recovery public key must carry a setup signature that verifies with verify_key(1) derived from this
 * device's own ADK(1) (held after the chain import). Throws `unverified` (no ADK(1), or the signature does not verify)
 * or `keys_legacy` (null signature); nothing is generated or sent.
 */
async function assertRecoveryKeyOwn(
  store: KeyStore,
  recoveryPublicKey: string,
  signature: string | null | undefined,
): Promise<void> {
  if (!(await store.hasAdk(1))) {
    throw new CryptoError('unverified', 'this device lacks ADK version 1 to check the recovery key against');
  }
  const adkV1 = await store.unwrapAdkRaw(1);
  let verifyKeyV1: Bytes;
  try {
    verifyKeyV1 = await verifyKeyOf(adkV1);
  } finally {
    zeroize(adkV1);
  }
  assertRecoveryKeySigned(recoveryPublicKey, signature, verifyKeyV1);
}

export async function prepareRotation(store: KeyStore, input: RotationInput): Promise<PreparedRotation> {
  assertVersion(input.serverKeyVersion);
  const local = await store.currentVersion();
  if (local !== input.serverKeyVersion) {
    throw new CryptoError(
      local < input.serverKeyVersion ? 'not_found' : 'invalid_input',
      `local ADK version ${local} differs from the server's ${input.serverKeyVersion}; accept pending keys first`,
    );
  }
  await assertRecoveryKeyOwn(store, input.recoveryPublicKey, input.recoverySignature);
  const exclude = new Set((input.exclude ?? []).map((id) => id.toLowerCase()));
  const next = generateAdk(local + 1);
  const previous = await store.unwrapAdkRaw(local);
  let request: RotateRequest;
  const skipped: PreparedRotation['skipped'] = [];
  try {
    // verify_key(v) from this device's own ADK(v): a proof the server vouches for is not enough (A.6 "Rotating").
    const currentVerifyKey = await verifyKeyOf(previous);
    const chain = await wrapChain(next.raw, previous, next.version);
    const recovery = await wrapAdk(next.raw, b64uDecode(input.recoveryPublicKey), 'recovery', next.version);
    const deviceBlobs: RotateRequest['device_blobs'] = [];
    for (const d of input.devices) {
      const reason = skipReason(d, local, currentVerifyKey, exclude);
      if (reason) {
        skipped.push({ device_id: d.device_id, reason });
        continue;
      }
      const blob = await wrapAdk(next.raw, b64uDecode(d.public_key as string), 'rotate', next.version);
      deviceBlobs.push({ device_id: d.device_id, blob: b64uEncode(blob) });
    }
    const verifyKey = await verifyKeyOf(next.raw);
    const signature = await signWithAdk(previous, utf8(rotationMessage(next.version, verifyKey, chain)));
    request = {
      key_version: next.version,
      recovery_blob: b64uEncode(recovery),
      chain_blob: b64uEncode(chain),
      device_blobs: deviceBlobs,
      verify_key: b64uEncode(verifyKey),
      signature: b64uEncode(signature),
    };
  } catch (err) {
    zeroize(next.raw);
    throw err;
  } finally {
    zeroize(previous);
  }
  let done = false;
  return {
    request,
    skipped,
    async commit() {
      if (done) throw invalid('rotation already committed or discarded');
      done = true;
      try {
        await store.saveAdk(next.version, next.raw);
      } finally {
        zeroize(next.raw);
      }
    },
    discard() {
      done = true;
      zeroize(next.raw);
    },
  };
}

/** An entry of `pending` from `GET /v1/keys`. */
export interface PendingBlob {
  key_version: number;
  blob: string;
  from_device_id: string;
}

export interface PendingResult {
  /** Versions now stored; acknowledge each with `DELETE /v1/keys/pending/{key_version}`. */
  accepted: number[];
  /**
   * Versions not stored and not to be acknowledged. `unverified`: the blob opened but its chain link or verify key
   * does not check out (a forged rotation; the UI says so); other codes: it did not open, or this device lacks the
   * version before it.
   */
  failed: { key_version: number; code: CryptoError['code'] }[];
}

/**
 * Picks up rotation blobs addressed to this device (purpose `rotate`, version bound by the AAD), ascending. A
 * candidate ADK(v) is stored only when this device already holds ADK(v-1), chain link v opened with the candidate
 * yields exactly that ADK(v-1), and the candidate derives `versions[v].verify_key` (contract A.6 "Rotation pickup").
 * `chain` is `GET /v1/keys/chain`.
 */
export async function acceptPendingBlobs(
  store: KeyStore,
  deviceKey: X25519KeyPair,
  pending: readonly PendingBlob[],
  chain: ChainState,
): Promise<PendingResult> {
  const result: PendingResult = { accepted: [], failed: [] };
  for (const p of [...pending].sort((a, b) => a.key_version - b.key_version)) {
    let raw: Bytes | null = null;
    let held: Bytes | null = null;
    try {
      assertVersion(p.key_version);
      if (p.key_version < 2) throw new CryptoError('unverified', 'a rotation blob exists only for key_version >= 2');
      if (!(await store.hasAdk(p.key_version - 1))) {
        throw new CryptoError('not_found', `this device lacks ADK version ${p.key_version - 1} to verify against`);
      }
      raw = await unwrapAdk(b64uDecode(p.blob), deviceKey, 'rotate', p.key_version);
      held = await store.unwrapAdkRaw(p.key_version - 1);
      await assertRotationLink(raw, held, chain, p.key_version);
      await store.saveAdk(p.key_version, raw);
      result.accepted.push(p.key_version);
    } catch (err) {
      result.failed.push({ key_version: p.key_version, code: err instanceof CryptoError ? err.code : 'invalid_input' });
    } finally {
      zeroize(raw, held);
    }
  }
  return result;
}

/** An entry of `chain` from `GET /v1/keys/chain`: ADK(v-1) wrapped by ADK(v). */
export interface ChainLink {
  key_version: number;
  blob: string;
}

/**
 * Walks the chain down from the newest stored ADK and stores every older version it can open, so entries
 * written before a rotation (or before this device paired) stay readable. Returns the versions added.
 *
 * Each older ADK(v-1) is checked before it is stored (contract I.6): it must derive `versions[v-1].verify_key`, and
 * `versions[v].signature` must verify with that key over the rotation message built from chain link v
 * ({@link rotationMessage}(v, `versions[v].verify_key`, link v)). Otherwise the walk stops with `unverified` (or
 * `keys_legacy` for a legacy row) and nothing more is stored. `state` is `GET /v1/keys/chain`.
 */
export async function importChain(store: KeyStore, state: ChainState): Promise<number[]> {
  const links = new Map(state.chain.map((l) => [l.key_version, l.blob]));
  const added: number[] = [];
  for (let v = await store.currentVersion(); v >= 2; v--) {
    if (await store.hasAdk(v - 1)) continue;
    const blob = links.get(v);
    if (!blob) break;
    const raw = await store.unwrapAdkRaw(v);
    let previous: Bytes | null = null;
    try {
      let link: Bytes;
      try {
        link = b64uDecode(blob);
      } catch {
        throw new CryptoError('unverified', `malformed chain link for version ${v}`);
      }
      previous = await unwrapChain(link, raw, v);
      await assertOlderVersion(state, v, previous, link);
      await store.saveAdk(v - 1, previous);
      added.push(v - 1);
    } finally {
      zeroize(raw, previous);
    }
  }
  return added;
}

/** I.6: ADK(v-1) opened from chain link v derives `versions[v-1].verify_key`, which signed version v over that link. */
async function assertOlderVersion(state: ChainState, v: number, previous: Uint8Array, link: Uint8Array) {
  const expected = versionVerifyKey(state.versions, v - 1);
  const own = await verifyKeyOf(previous);
  if (!equalBytes(own, expected)) {
    throw new CryptoError('unverified', `ADK version ${v - 1} from the chain does not match the account's verify key`);
  }
  const row = state.versions.find((r) => r.key_version === v);
  if (row?.signature === null) {
    throw new CryptoError('keys_legacy', 'the account keys predate key authenticity and must be set up again');
  }
  let signature: Bytes;
  try {
    signature = b64uDecode(row?.signature ?? '');
  } catch {
    throw new CryptoError('unverified', `malformed signature for version ${v}`);
  }
  const message = utf8(rotationMessage(v, versionVerifyKey(state.versions, v), link));
  if (!verifySignature(signature, message, own)) {
    throw new CryptoError('unverified', `version ${v} is not signed by version ${v - 1}`);
  }
}
