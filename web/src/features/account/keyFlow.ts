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
import type { AccountApi, KeysState, PairingPeer } from './api';
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
}

/** Key checks run one after another, so two callers never create two device keys at once. */
let queue: Promise<unknown> = Promise.resolve();

async function ackAccepted(api: AccountApi, versions: number[]) {
  for (const v of versions) await api.ackPending(v).catch(() => undefined);
}

async function importOlder(api: AccountApi, store: KeyStore) {
  const local = await store.currentVersion();
  if (local < 2 || (await store.allVersions()).length >= local) return;
  const { chain } = await api.chain();
  await importChain(store, chain);
}

/**
 * Brings this added device's keys up to date and says what it still needs: registers the device wrapping key
 * when it is new or differs from the server's, picks up rotation blobs addressed to it (then acknowledges
 * them), and imports older ADK versions through the chain so entries written before a rotation stay readable.
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
  let { keyPair, created } = await getOrCreateDeviceKey(store);
  let state = await api.keys();
  if (state.key_version === 0 && (await store.currentVersion()) > 0) {
    // The account has no key (it was reset) but this browser holds an old one: start clean.
    await store.wipe();
    ({ keyPair, created } = await getOrCreateDeviceKey(store));
  }
  const pub = publicKeyB64(keyPair);
  const mine = state.devices.find((d) => d.device_id === deviceId);
  if (created || mine?.public_key !== pub) {
    await api.registerKey(pub);
    state = await api.keys();
  }
  await meta.setOwner(userId).catch(() => undefined);
  if (state.pending.length) {
    const res = await acceptPendingBlobs(store, keyPair, state.pending);
    await ackAccepted(api, res.accepted);
  }
  const local = await store.currentVersion();
  const status = deriveKeyStatus(state.key_version, local);
  if (status === 'ready') await importOlder(api, store);
  return { status, keyVersion: state.key_version, state };
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

/** AC-6, new device: stores the ADK an existing device wrapped for it (sender must be a device of the account). */
export async function finishPairing(api: AccountApi, keys: PairingKeys, ready: PairingReady): Promise<number> {
  const store = await keyStore();
  const state = await api.keys();
  const v = await acceptPairing(store, keys, ready, { trustedSenderKeys: state.devices.map((d) => d.public_key) });
  void requestPersistentStorage();
  await importOlder(api, store);
  return v;
}

/** AC-6, recovery phrase: unwraps the newest ADK with the phrase, then older versions through the chain. */
export async function recoverKeys(
  api: AccountApi,
  phrase: string,
  onProgress?: (fraction: number) => void,
): Promise<number> {
  const store = await keyStore();
  const rec = await api.recovery();
  const v = await recoverWithPhrase(store, phrase, rec, onProgress ? { onProgress } : {});
  void requestPersistentStorage();
  await importOlder(api, store);
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
      // A rotation happened since this device last looked: pick up the newer key and try once more.
      if (attempt === 0 && e instanceof ApiError && e.code === 'key_version_conflict') {
        await checkKeys(api, userId, deviceId);
        continue;
      }
      throw e;
    }
  }
}

/**
 * After revoking a device (DV-2): generate ADK(v+1), wrap it for the recovery key and every remaining added
 * device, and store it once the server accepts. `devices_changed` (a device was added or removed meanwhile) and
 * `key_version_conflict` (another device rotated first) refetch the key state and retry.
 */
export async function rotateKeys(api: AccountApi, userId: string, deviceId: string): Promise<'rotated' | 'none'> {
  const store = await keyStore();
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const check = await checkKeys(api, userId, deviceId);
    const { state } = check;
    if (state.key_version === 0 || !state.recovery) return 'none';
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
