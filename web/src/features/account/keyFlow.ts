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
  /** GET /v1/keys after registration, pickup and any owed rotation. */
  state: KeysState;
  /** ADK versions stored by this check (pickup, chain import): entries skipped as unreadable are pulled again. */
  newVersions: number[];
  /**
   * The server still says a rotation is owed (`rotation_due`, contract E) although this device is ready: the automatic
   * rotation failed (offline, a race that did not settle). Kept by the server, so the next key check tries again.
   */
  rotationOwed: boolean;
}

/**
 * A key state that stops a rotation before it starts (docs/CLIPBOARD_PROTOCOL.md §1): `refused` (the server refused
 * this device's own key proof), `rejected`, `legacy`, or `not_ready` (the device lacks the newest key).
 */
export class KeyStateError extends Error {
  constructor(readonly code: 'refused' | 'rejected' | 'legacy' | 'not_ready') {
    super(`key state: ${code}`);
    this.name = 'KeyStateError';
  }
}

/** Key checks and rotations run one after another, so two callers never create two device keys or ADKs at once. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

async function ackAccepted(api: AccountApi, versions: number[]) {
  for (const v of versions) await api.ackPending(v).catch(() => undefined);
}

/**
 * Older ADK versions through the chain (fetched unless the caller already has it), each checked against the signed
 * version list before it is stored (contract I.6). Returns the versions added.
 */
async function importOlder(api: AccountApi, store: KeyStore, chain?: KeyChain): Promise<number[]> {
  const local = await store.currentVersion();
  if (local < 2 || (await store.allVersions()).length >= local) return [];
  return importChain(store, chain ?? (await api.chain()));
}

const lower = (ids: readonly string[]) => [...new Set(ids.map((id) => id.toLowerCase()))];

/** Revoked device IDs still to exclude (contract I.4); an unreadable store gives none (the caller's list still applies). */
async function pendingExclusions(userId: string): Promise<string[]> {
  return syncMeta()
    .excluded(userId)
    .catch(() => []);
}

/**
 * Contract I.4: remembers devices this browser revoked (IndexedDB, next to the sync bookkeeping, never Web Storage), so
 * every rotation it makes keeps excluding them until one that excluded them has gone through, even if the tab closes
 * between the revoke and the rotation, or the rotation fails and is retried later as an owed one.
 */
export async function rememberRevoked(userId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const meta = syncMeta();
  await meta.setExcluded(userId, lower([...(await meta.excluded(userId)), ...ids]));
}

/** Drops IDs from the remembered exclusions (a rotation that excluded them succeeded, or the revoke was refused). */
export async function forgetRevoked(userId: string, ids: readonly string[]): Promise<void> {
  const meta = syncMeta();
  const drop = new Set(lower(ids));
  await meta.setExcluded(
    userId,
    (await meta.excluded(userId)).filter((id) => !drop.has(id)),
  );
}

const apiCode = (e: unknown, ...codes: string[]) => e instanceof ApiError && codes.includes(e.code);

/**
 * Brings this added device's keys up to date and says what it still needs (docs/CLIPBOARD_PROTOCOL.md §1):
 * - never wipes keys because of what the server says about the same account: a `key_version` of 0 or below the
 *   newest held version gives `rejected` and the keys stay (contract F.2); keys are wiped only on sign-out, another
 *   account owner, or the account session ending;
 * - picks up rotation blobs addressed to it, storing (then acknowledging) only those whose chain link and verify key
 *   check out; a blob that does not verify is neither stored nor acknowledged, and the status becomes `rejected`;
 * - registers the device wrapping key once it holds an ADK, and again whenever the newest held version is newer than
 *   its registration (contract D.4), with a proof by that version; `409 key_version_conflict` refreshes (picks up
 *   pending blobs) and retries once;
 * - imports older ADK versions through the chain so entries written before a rotation stay readable;
 * - when ready and the server says a rotation is owed (`rotation_due`: a device holding the key left), rotates
 *   (contract E.3); a failure leaves `rotationOwed` set and is retried by the next check.
 * `409 keys_legacy` gives `legacy`; the server refusing this device's own proof gives `refused` (contract F.3).
 */
export function checkKeys(api: AccountApi, userId: string, deviceId: string): Promise<KeyCheck> {
  return enqueue(() => checkAndRotate(api, userId, deviceId));
}

async function checkAndRotate(api: AccountApi, userId: string, deviceId: string): Promise<KeyCheck> {
  const check = await checkKeysNow(api, userId, deviceId);
  if (check.status !== 'ready' || !check.state.rotation_due) return check;
  try {
    await rotateNow(api, userId, deviceId, [], true);
  } catch (e) {
    // `not_ready` (another device rotated meanwhile and this one lacks the newest key, contract I.5): the fresh key
    // check below picks the key up or says to pair; it is not a failed rotation to retry.
    if (!(e instanceof KeyStateError && e.code === 'not_ready')) {
      const status = rotationErrorStatus(e);
      // A refusal is a key state of its own; anything else (offline, a race that did not settle) stays owed.
      if (status) return { ...check, status, rotationOwed: false };
      return { ...check, rotationOwed: true };
    }
  }
  const after = await checkKeysNow(api, userId, deviceId);
  return { ...after, newVersions: [...check.newVersions, ...after.newVersions] };
}

/** The key state a failed rotation leaves, or null when it is only a failure to retry (contract F.3). */
export function rotationErrorStatus(e: unknown): KeyStatus | null {
  if (e instanceof KeyStateError) return e.code === 'not_ready' ? null : e.code;
  if (apiCode(e, 'rotation_unauthorized', 'device_key_unproven', 'key_version_conflict')) return 'refused';
  if (apiCode(e, 'keys_legacy') || (e instanceof CryptoError && e.code === 'keys_legacy')) return 'legacy';
  if (e instanceof CryptoError && e.code === 'unverified') return 'rejected';
  return null;
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
  const { keyPair } = await getOrCreateDeviceKey(store);
  let state = await api.keys();
  await meta.setOwner(userId).catch(() => undefined);
  const held = await store.currentVersion();
  if (held > 0 && state.key_version < held) {
    // The server says this account has no key, or an older one than this device holds (contract F.2): a reset
    // cannot happen while the device stays in the account, so this is refused and the keys are kept.
    return { status: 'rejected', keyVersion: state.key_version, state, newVersions: [], rotationOwed: false };
  }
  const newVersions: number[] = [];
  let rejected = false;
  let legacy = false;
  let refused = false;
  let chain: KeyChain | undefined;
  const pub = publicKeyB64(keyPair);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (state.pending.length) {
      chain = await api.chain();
      const res = await acceptPendingBlobs(store, keyPair, state.pending, chain);
      await ackAccepted(api, res.accepted);
      newVersions.push(...res.accepted);
      if (res.failed.some((f) => f.code === 'unverified')) rejected = true;
      if (res.failed.some((f) => f.code === 'keys_legacy')) legacy = true;
    }
    // Re-prove whenever the newest held version is newer than this device's registration (contract D.4).
    const newest = await store.currentVersion();
    const mine = state.devices.find((d) => d.device_id === deviceId);
    const stale =
      mine?.public_key !== pub || !mine.proof || typeof mine.key_version !== 'number' || mine.key_version < newest;
    if (newest === 0 || !stale) break;
    const registration = await proveDeviceKey(store, deviceId, keyPair);
    if (!registration) break;
    try {
      await api.registerKey(registration);
      state = await api.keys();
      break;
    } catch (e) {
      if (apiCode(e, 'key_version_conflict') && attempt === 0) {
        // A rotation happened since: refresh and pick up its blob, then prove with the newer version.
        state = await api.keys();
        continue;
      }
      if (apiCode(e, 'keys_legacy')) legacy = true;
      else if (apiCode(e, 'key_version_conflict')) {
        // A second conflict (contract I.1): when the account moved past every version this device holds, it was left
        // behind (it got no blob for a version in between) and must pair again (`pair`); at an equal version the
        // server is refusing this device's own proof (`refused`).
        state = await api.keys();
        if (state.key_version <= (await store.currentVersion())) refused = true;
      } else if (apiCode(e, 'device_key_unproven')) refused = true;
      else throw e;
      break;
    }
  }
  const local = await store.currentVersion();
  let status = deriveKeyStatus(state.key_version, local);
  if (legacy) status = 'legacy';
  else if (rejected) status = 'rejected';
  else if (refused) status = 'refused';
  else if (status === 'ready') newVersions.push(...(await importOlder(api, store, chain)));
  return { status, keyVersion: state.key_version, state, newVersions, rotationOwed: false };
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
  const [rec, chain, state] = await Promise.all([api.recovery(), api.chain(), api.keys()]);
  // Anchor, recovery key and its signature, signature chain and verify key are checked before anything is stored
  // (contract A.6 "Recovery", H.4).
  const v = await recoverWithPhrase(store, phrase, rec, chain, state.recovery, onProgress ? { onProgress } : {});
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
 * After revoking a device (DV-2), or when the server says a rotation is owed (contract E.3): generate ADK(v+1), wrap
 * it for the recovery key (only once its setup signature verifies with this device's own ADK(1), contract H.3) and
 * every remaining added device whose key is proven by the current version (never to the IDs in `exclude`, such as the
 * device just revoked, nor to any revoked device remembered from an earlier call until a rotation that excluded it went
 * through, contract I.4), sign it with version v, and store it once the server accepts.
 * `devices_changed` (a device was added, removed or re-proved meanwhile; its body lists `missing` and `unexpected`
 * IDs) and `key_version_conflict` (another device rotated first) refresh the key state and retry once; after a conflict,
 * when the account already moved past the version this rotation started from and no rotation is owed any more, another
 * device made it: this one picks up its blob and does not rotate again (contract I.2). A refusal of this device's own
 * rotation (`rotation_unauthorized`, a conflict that persists) is `refused` for the caller ({@link rotationErrorStatus}),
 * an unverifiable recovery key `rejected`.
 */
export function rotateKeys(
  api: AccountApi,
  userId: string,
  deviceId: string,
  exclude: readonly string[] = [],
): Promise<'rotated' | 'none'> {
  return enqueue(async () => {
    await rememberRevoked(userId, exclude).catch(() => undefined);
    return rotateNow(api, userId, deviceId, exclude, false);
  });
}

/**
 * A remembered exclusion is a device this browser revoked whose excluding rotation has not gone through yet. If the
 * server then answers `devices_changed` listing it as `missing` and still lists it in `GET /v1/devices`, the revoke
 * did not take effect (the request got no answer) or the device signed in again before the rotation. Either way the
 * user asked for that device to be revoked, so the revoke is sent again and the device stays excluded; it is never
 * forgotten here, so a server cannot talk this browser into wrapping a new key to it (QA rounds 4 and 5). A server
 * that keeps refusing can only block the rotation (denial of service). IDs revoked in this very call are left alone
 * (their revoke just succeeded).
 */
async function completeRevokes(
  api: AccountApi,
  excluded: readonly string[],
  body: unknown,
  explicit: readonly string[],
): Promise<void> {
  const missing = lower(
    body && typeof body === 'object' && Array.isArray((body as { missing?: unknown }).missing)
      ? ((body as { missing: unknown[] }).missing.filter((x) => typeof x === 'string') as string[])
      : [],
  );
  const keep = new Set(lower([...explicit]));
  const candidates = missing.filter((id) => excluded.includes(id) && !keep.has(id));
  if (candidates.length === 0) return;
  const { devices } = await api.devices();
  const present = new Set(lower(devices.map((d) => d.id)));
  for (const id of candidates.filter((c) => present.has(c))) {
    try {
      await api.revokeDevice(id);
    } catch (e) {
      // Already gone (404) is fine; anything else surfaces through the next attempt's devices_changed.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
}

async function rotateNow(
  api: AccountApi,
  userId: string,
  deviceId: string,
  exclude: readonly string[],
  /** An owed rotation (E.3): stop as soon as the server no longer says one is due (another device made it). */
  owed: boolean,
): Promise<'rotated' | 'none'> {
  const store = await keyStore();
  const excluded = lower([...exclude, ...(await pendingExclusions(userId))]);
  /** The version a rotation refused with `key_version_conflict` started from (I.2). */
  let conflictedFrom: number | null = null;
  for (let attempt = 0; ; attempt++) {
    const check = await checkKeysNow(api, userId, deviceId);
    const { state } = check;
    if (state.key_version === 0 || (owed && !state.rotation_due)) return 'none';
    // An account with keys always has a signed recovery key; a server that omits it cannot silently suppress the
    // rotation a revoke needs (QA round 4 P2-2).
    if (!state.recovery) throw new KeyStateError('rejected');
    if (conflictedFrom !== null && state.key_version > conflictedFrom && !state.rotation_due) return 'rotated';
    if (check.status === 'rejected' || check.status === 'refused' || check.status === 'legacy') {
      throw new KeyStateError(check.status);
    }
    if (check.status !== 'ready') throw new KeyStateError('not_ready');
    const prep = await prepareRotation(store, {
      serverKeyVersion: state.key_version,
      recoveryPublicKey: state.recovery.public_key,
      recoverySignature: state.recovery.signature,
      devices: state.devices,
      exclude: excluded,
    });
    try {
      await api.rotate(prep.request);
    } catch (e) {
      prep.discard();
      if (
        attempt === 0 &&
        e instanceof ApiError &&
        (e.code === 'devices_changed' || e.code === 'key_version_conflict')
      ) {
        // The body lists `missing` and `unexpected` device IDs (contract D.2). Either way the refreshed GET /v1/keys is
        // the truth: a device that left drops out, one that re-proved at the current version gets a blob, and this
        // device re-proves first if it was behind.
        if (e.code === 'key_version_conflict') conflictedFrom = state.key_version;
        if (e.code === 'devices_changed') await completeRevokes(api, excluded, e.body, exclude);
        continue;
      }
      throw e;
    }
    await prep.commit();
    // The server keeps a safety copy wrapped to this device; it is stored now, so acknowledge it.
    await api.ackPending(prep.request.key_version).catch(() => undefined);
    await forgetRevoked(userId, excluded).catch(() => undefined);
    return 'rotated';
  }
}
