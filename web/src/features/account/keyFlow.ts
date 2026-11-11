// Account key steps for the Web UI (PRD §7.5, docs/CLIPBOARD_PROTOCOL.md §1). Loaded on demand together with the
// crypto library, so neither is part of the main bundle.
import {
  CryptoError,
  acceptPairing,
  acceptPendingBlobs,
  createPairingKeys,
  getOrCreateDeviceKey,
  importChain,
  openKeyStore,
  pairingPayload,
  parsePairingPayload,
  prepareKeySetup,
  prepareRotation,
  proveDeviceKey,
  publicKeyB64,
  recoverWithPhrase,
  requestPersistentStorage,
  wrapForPairing,
  type KeyStore,
  type PairingKeys,
  type PairingReady,
  type PreparedSetup,
} from '../../lib/crypto';
import { ApiError } from '../../lib/api/errors';
import type { AccountApi, KeyChain, KeysState, PairingPeer } from './api';
import { deriveKeyStatus, type KeyStatus } from './state';
import { openSyncMeta, type SyncMetaStore } from './sync/syncMeta';

let storePromise: Promise<KeyStore> | null = null;
let metaStore: SyncMetaStore | null = null;

/** The device key store, opened once per tab. */
export function keyStore(): Promise<KeyStore> {
  storePromise ??= openKeyStore().catch((e: unknown) => {
    storePromise = null;
    throw e;
  });
  return storePromise;
}

export function syncMeta(): SyncMetaStore {
  metaStore ??= openSyncMeta();
  return metaStore;
}

export interface KeyCheck {
  status: KeyStatus;
  keyVersion: number;
  /** GET /v1/keys after registration and pickup. */
  state: KeysState;
  /** ADK versions stored by this check (pickup, chain import): entries skipped as unreadable are pulled again. */
  newVersions: number[];
}

/** Key checks run one after another, so two callers never create two device keys at once. */
let queue: Promise<unknown> = Promise.resolve();

async function ackAccepted(api: AccountApi, versions: number[]) {
  for (const v of versions) await api.ackPending(v).catch(() => undefined);
}

/** Older ADK versions through the chain (fetched unless the caller already has it). Returns the versions added. */
async function importOlder(api: AccountApi, store: KeyStore, chain?: KeyChain): Promise<number[]> {
  const local = await store.currentVersion();
  if (local < 2 || (await store.allVersions()).length >= local) return [];
  return importChain(store, (chain ?? (await api.chain())).chain);
}

const apiCode = (e: unknown, code: string) => e instanceof ApiError && e.code === code;

/**
 * Brings this added device's keys up to date and says what it still needs (docs/CLIPBOARD_PROTOCOL.md §1):
 * - picks up rotation blobs addressed to it, storing (then acknowledging) only those whose chain link and verify key
 *   check out; a blob that does not verify is neither stored nor acknowledged, and the status becomes `rejected`;
 * - registers the device wrapping key only once the device holds an ADK (after setup, pairing or recovery), with a
 *   proof by the newest version it holds, when the server has no proven registration of this key;
 * - imports older ADK versions through the chain so entries written before a rotation stay readable.
 * `409 keys_legacy` (pre-release keys) gives `legacy`; `403 device_key_unproven` gives `rejected`.
 */
export function checkKeys(api: AccountApi, userId: string, deviceId: string): Promise<KeyCheck> {
  const run = queue.then(() => checkKeysNow(api, userId, deviceId));
  queue = run.catch(() => undefined);
  return run;
}

async function checkKeysNow(api: AccountApi, userId: string, deviceId: string): Promise<KeyCheck> {
  const store = await keyStore();
  const meta = syncMeta();
  // Keys left behind by another account (it ended while this tab was closed) are never reused.
  const owner = await meta.owner().catch(() => null);
  if (owner && owner !== userId) {
    await store.wipe();
    await meta.wipe().catch(() => undefined);
  }
  let { keyPair } = await getOrCreateDeviceKey(store);
  let state = await api.keys();
  if (state.key_version === 0 && (await store.currentVersion()) > 0) {
    // The account has no key (it was reset) but this browser holds an old one: start clean.
    await store.wipe();
    ({ keyPair } = await getOrCreateDeviceKey(store));
  }
  await meta.setOwner(userId).catch(() => undefined);
  const newVersions: number[] = [];
  let rejected = false;
  let legacy = false;
  let chain: KeyChain | undefined;
  if (state.pending.length) {
    chain = await api.chain();
    const res = await acceptPendingBlobs(store, keyPair, state.pending, chain);
    await ackAccepted(api, res.accepted);
    newVersions.push(...res.accepted);
    rejected = res.failed.some((f) => f.code === 'unverified');
    legacy = res.failed.some((f) => f.code === 'keys_legacy');
  }
  const pub = publicKeyB64(keyPair);
  const mine = state.devices.find((d) => d.device_id === deviceId);
  if (mine?.public_key !== pub || !mine.proof) {
    const registration = await proveDeviceKey(store, deviceId, keyPair);
    if (registration) {
      try {
        await api.registerKey(registration);
        state = await api.keys();
      } catch (e) {
        if (apiCode(e, 'keys_legacy')) legacy = true;
        else if (apiCode(e, 'device_key_unproven')) rejected = true;
        else throw e;
      }
    }
  }
  const local = await store.currentVersion();
  let status = deriveKeyStatus(state.key_version, local);
  if (legacy) status = 'legacy';
  else if (rejected) status = 'rejected';
  else if (status === 'ready') newVersions.push(...(await importOlder(api, store, chain)));
  return { status, keyVersion: state.key_version, state, newVersions };
}

/** Sign-out or leaving the account: erases every key and the sync bookkeeping in this browser. */
export async function wipeAccountData(): Promise<void> {
  const errors: unknown[] = [];
  try {
    await (await keyStore()).wipe();
  } catch (e) {
    errors.push(e);
  }
  try {
    await syncMeta().wipe();
  } catch (e) {
    errors.push(e);
  }
  if (errors.length) throw errors[0];
}

/** AC-5: ADK and recovery phrase for the first device (nothing is stored or sent until the user confirms). */
export async function prepareSetup(): Promise<PreparedSetup> {
  const store = await keyStore();
  void requestPersistentStorage();
  return prepareKeySetup(store);
}

export type { PreparedSetup, PairingKeys };

export interface PairingStart {
  keys: PairingKeys;
  pairingId: string;
  /** `sa1.<code>.<fingerprint>`: QR and copyable text. */
  payload: string;
  expiresAt: number;
}

/** AC-6, new device: an ephemeral key and a pairing code for an existing device to scan or paste. */
export async function startPairing(api: AccountApi): Promise<PairingStart> {
  const keys = await createPairingKeys();
  const p = await api.createPairing(keys.ephemeralPublicKey);
  return {
    keys,
    pairingId: p.pairing_id,
    payload: pairingPayload(p.code, keys.ephemeralPublicKey),
    expiresAt: Date.parse(p.expires_at),
  };
}

/**
 * AC-6, new device: stores the ADK an existing device wrapped for it (sender must be a device of the account, the key
 * must match the account's signed versions). The caller then refreshes the key state, which registers this device.
 */
export async function finishPairing(api: AccountApi, keys: PairingKeys, ready: PairingReady): Promise<number> {
  const store = await keyStore();
  const [state, chain] = await Promise.all([api.keys(), api.chain()]);
  // Verified against the account's signed versions before anything is stored (contract A.6 "Pairing receive").
  const v = await acceptPairing(store, keys, ready, chain, {
    trustedSenderKeys: state.devices.map((d) => d.public_key),
  });
  void requestPersistentStorage();
  await importOlder(api, store, chain);
  return v;
}

/** AC-6, recovery phrase: unwraps and verifies the newest ADK with the phrase, then older versions through the chain. */
export async function recoverKeys(
  api: AccountApi,
  phrase: string,
  onProgress?: (fraction: number) => void,
): Promise<number> {
  const store = await keyStore();
  const [rec, chain] = await Promise.all([api.recovery(), api.chain()]);
  // Anchor, signature chain and verify key are checked before anything is stored (contract A.6 "Recovery").
  const v = await recoverWithPhrase(store, phrase, rec, chain, onProgress ? { onProgress } : {});
  void requestPersistentStorage();
  await importOlder(api, store, chain);
  return v;
}

export { parsePairingPayload };

export interface CodeLookup {
  code: string;
  fingerprint: string;
  peer: PairingPeer;
}

/** Existing device: resolves pasted or scanned pairing text to the new device waiting for the key. */
export async function lookupCode(api: AccountApi, text: string): Promise<CodeLookup | null> {
  const parsed = parsePairingPayload(text);
  if (!parsed) return null;
  const peer = await api.lookupPairing(parsed.code);
  return { ...parsed, peer };
}

/** Existing device: wraps the newest ADK to the new device's ephemeral key (fingerprint checked) and uploads it. */
export async function sendKeyTo(api: AccountApi, userId: string, deviceId: string, found: CodeLookup) {
  const store = await keyStore();
  for (let attempt = 0; ; attempt++) {
    const { keyPair } = await getOrCreateDeviceKey(store);
    const req = await wrapForPairing(store, keyPair, found.peer.ephemeral_public_key, found.fingerprint);
    try {
      await api.wrapPairing(found.code, req);
      return;
    } catch (e) {
      // A rotation happened since this device last looked, or the server has no proven registration of this
      // device's key yet (the wrap must come from it): bring the keys up to date and try once more.
      if (
        attempt === 0 &&
        e instanceof ApiError &&
        (e.code === 'key_version_conflict' || e.code === 'device_key_unproven')
      ) {
        await checkKeys(api, userId, deviceId);
        continue;
      }
      throw e;
    }
  }
}

/**
 * After revoking a device (DV-2): generate ADK(v+1), wrap it for the recovery key and every remaining added device
 * whose key registration verifies, sign it with version v, and store it once the server accepts. `devices_changed`
 * (a device was added or removed meanwhile) and `key_version_conflict` (another device rotated first) refetch the key
 * state and retry; `403 rotation_unauthorized` and `409 keys_legacy` propagate to the caller.
 */
export async function rotateKeys(api: AccountApi, userId: string, deviceId: string): Promise<'rotated' | 'none'> {
  const store = await keyStore();
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const check = await checkKeys(api, userId, deviceId);
    const { state } = check;
    if (state.key_version === 0 || !state.recovery) return 'none';
    if (check.status === 'rejected') throw new CryptoError('unverified', 'a key change could not be verified');
    if (check.status === 'legacy') throw new CryptoError('keys_legacy', 'the account keys must be set up again');
    if (check.status !== 'ready') throw new CryptoError('not_found', 'this device does not hold the newest key');
    const prep = await prepareRotation(store, {
      serverKeyVersion: state.key_version,
      recoveryPublicKey: state.recovery.public_key,
      devices: state.devices,
    });
    try {
      await api.rotate(prep.request);
    } catch (e) {
      prep.discard();
      last = e;
      if (e instanceof ApiError && (e.code === 'devices_changed' || e.code === 'key_version_conflict')) continue;
      throw e;
    }
    await prep.commit();
    // The server keeps a safety copy wrapped to this device; it is stored now, so acknowledge it.
    await api.ackPending(prep.request.key_version).catch(() => undefined);
    return 'rotated';
  }
  throw last ?? new Error('rotation did not converge');
}
