import { generateAdk } from './adk';
import { CryptoError, invalid } from './errors';
import { assertVersion, b64uDecode, b64uEncode, zeroize, type Bytes } from './encoding';
import type { KeyStore } from './store';
import { unwrapAdk, unwrapChain, wrapAdk, wrapChain } from './wrap';
import type { X25519KeyPair } from './x25519';

/**
 * Key rotation (PRD §7.5 "Revoking a device bumps key_version", contract §Keys `POST /v1/keys/rotate`).
 * The revoking device generates ADK(v+1), chains ADK(v) under it, wraps it to the recovery public key and to
 * every remaining added device with a registered key, and stores it only after the server accepts.
 */
export interface DeviceKeyInfo {
  device_id: string;
  public_key: string | null;
}

export interface RotateRequest {
  key_version: number;
  recovery_blob: string;
  chain_blob: string;
  device_blobs: { device_id: string; blob: string }[];
}

export interface PreparedRotation {
  request: RotateRequest;
  /** Devices left without a blob because they registered no public key (they must pair again). */
  skipped: string[];
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
   * `devices` from `GET /v1/keys` (after the revoke). Every device with a public key gets a blob, this one
   * included: if storing locally fails after the server accepted, the device can still pick up its own
   * pending blob.
   */
  devices: readonly DeviceKeyInfo[];
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
  const next = generateAdk(local + 1);
  const previous = await store.unwrapAdkRaw(local);
  let request: RotateRequest;
  const skipped: string[] = [];
  try {
    const chain = await wrapChain(next.raw, previous, next.version);
    const recovery = await wrapAdk(next.raw, b64uDecode(input.recoveryPublicKey), 'recovery', next.version);
    const deviceBlobs: RotateRequest['device_blobs'] = [];
    for (const d of input.devices) {
      if (!d.public_key) {
        skipped.push(d.device_id);
        continue;
      }
      const blob = await wrapAdk(next.raw, b64uDecode(d.public_key), 'rotate', next.version);
      deviceBlobs.push({ device_id: d.device_id, blob: b64uEncode(blob) });
    }
    request = {
      key_version: next.version,
      recovery_blob: b64uEncode(recovery),
      chain_blob: b64uEncode(chain),
      device_blobs: deviceBlobs,
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
  failed: { key_version: number; code: CryptoError['code'] }[];
}

/** Unwraps rotation blobs addressed to this device (purpose `rotate`, version bound by the AAD). */
export async function acceptPendingBlobs(
  store: KeyStore,
  deviceKey: X25519KeyPair,
  pending: readonly PendingBlob[],
): Promise<PendingResult> {
  const result: PendingResult = { accepted: [], failed: [] };
  for (const p of [...pending].sort((a, b) => a.key_version - b.key_version)) {
    let raw: Bytes | null = null;
    try {
      assertVersion(p.key_version);
      raw = await unwrapAdk(b64uDecode(p.blob), deviceKey, 'rotate', p.key_version);
      await store.saveAdk(p.key_version, raw);
      result.accepted.push(p.key_version);
    } catch (err) {
      result.failed.push({ key_version: p.key_version, code: err instanceof CryptoError ? err.code : 'invalid_input' });
    } finally {
      zeroize(raw);
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
 */
export async function importChain(store: KeyStore, chain: readonly ChainLink[]): Promise<number[]> {
  const links = new Map(chain.map((l) => [l.key_version, l.blob]));
  const added: number[] = [];
  for (let v = await store.currentVersion(); v >= 2; v--) {
    if (await store.hasAdk(v - 1)) continue;
    const blob = links.get(v);
    if (!blob) break;
    const raw = await store.unwrapAdkRaw(v);
    let previous: Bytes | null = null;
    try {
      previous = await unwrapChain(b64uDecode(blob), raw, v);
      await store.saveAdk(v - 1, previous);
      added.push(v - 1);
    } finally {
      zeroize(raw, previous);
    }
  }
  return added;
}
