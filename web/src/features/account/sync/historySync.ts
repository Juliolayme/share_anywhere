// Encrypted cloud history sync (PRD §2 "History", §7.5; docs/API.md §2.4 "History"). Loaded on demand with the
// crypto library.
import { decryptItemText, encryptItem, itemFromWire, itemToWire, type KeyStore } from '../../../lib/crypto';
import { ApiError } from '../../../lib/api/errors';
import type { HistoryEntry, HistoryStore } from '../../history/store/history-store';
import type { AccountApi } from '../api';
import type { AccountSyncMeta, SyncMetaStore } from './syncMeta';

/** Local id of an entry pulled from the account: `sync:<entry_id>`. */
export const SYNC_PREFIX = 'sync:';
export const syncedId = (entryId: string) => `${SYNC_PREFIX}${entryId}`;

/**
 * Server `entry_id` (a UUID) for a local entry: SHA-256 of `<local id>|<device id>`, shaped as a version-8 UUID.
 * Deterministic, so re-uploading the same entry from this device is idempotent; the device ID keeps two devices
 * that received in the same session (both `rx:<session>`) apart.
 */
export async function entryUuid(localId: string, deviceId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${localId}|${deviceId}`)),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const omit = (rec: Record<string, string>, keys: string[]) =>
  Object.fromEntries(Object.entries(rec).filter(([k]) => !keys.includes(k)));

const DIRECTIONS = new Set(['sent', 'received']);
const STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);
const ROUTES = new Set(['direct', 'relay', 'mixed']);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const str = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length <= max;

/** Validates a decrypted entry: only known fields with sane types reach the History view. */
export function parseEntry(text: string): Omit<HistoryEntry, 'id'> | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const { direction, title, fileCount, totalBytes, peer, status, createdAt } = raw;
  if (!str(direction) || !DIRECTIONS.has(direction) || !str(status) || !STATUSES.has(status)) return null;
  if (!str(title) || !str(peer) || !num(fileCount) || !num(totalBytes) || !num(createdAt)) return null;
  const e: Omit<HistoryEntry, 'id'> = {
    direction: direction as HistoryEntry['direction'],
    title,
    fileCount,
    totalBytes,
    peer,
    status: status as HistoryEntry['status'],
    createdAt,
  };
  if (num(raw.transferredBytes)) e.transferredBytes = raw.transferredBytes;
  if (num(raw.startedAt)) e.startedAt = raw.startedAt;
  if (str(raw.route) && ROUTES.has(raw.route)) e.route = raw.route as NonNullable<HistoryEntry['route']>;
  if (Array.isArray(raw.peers) && raw.peers.length <= 5 && raw.peers.every((p) => str(p, 120)))
    e.peers = raw.peers as string[];
  if (Array.isArray(raw.files) && raw.files.length <= 1000) {
    const files = raw.files.filter(
      (f): f is { name: string; size: number; transferredBytes?: number } =>
        !!f && typeof f === 'object' && str((f as { name?: unknown }).name) && num((f as { size?: unknown }).size),
    );
    e.files = files.map((f) => ({
      name: f.name,
      size: f.size,
      ...(num(f.transferredBytes) ? { transferredBytes: f.transferredBytes } : {}),
    }));
  }
  return e;
}

/** What is uploaded: the entry without local-only fields (`origin` names the device it came from here). */
function payloadOf(entry: HistoryEntry): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, origin, ...rest } = entry;
  return JSON.stringify(rest);
}

export interface SyncDeps {
  api: AccountApi;
  keys: KeyStore;
  history: HistoryStore;
  meta: SyncMetaStore;
  userId: string;
  deviceId: string;
  /** Account-wide `history_sync` (GET /v1/me). Off: only a pending import uploads, nothing is pulled. */
  enabled: boolean;
  /** Device names by ID (GET /v1/devices) for the origin shown on pulled entries. */
  deviceNames?: Map<string, string>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  removed: number;
  /** Entries this device cannot read yet (a key version it does not hold): pair again or use the phrase. */
  unreadable: number;
}

async function flushDeletes(deps: SyncDeps, meta: AccountSyncMeta) {
  if (meta.pendingClear) {
    await deps.api.clearHistory();
    meta.pendingClear = false;
    meta.pendingDeletes = [];
  }
  while (meta.pendingDeletes.length) {
    const id = meta.pendingDeletes[0] as string;
    try {
      await deps.api.deleteHistoryEntry(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    meta.pendingDeletes.shift();
  }
}

async function push(deps: SyncDeps, meta: AccountSyncMeta): Promise<number> {
  if (!deps.enabled && !meta.importPending) return 0;
  const v = await deps.keys.currentVersion();
  if (v === 0) return 0;
  const key = await deps.keys.loadSubkeys(v, 'history');
  let pushed = 0;
  for (const entry of await deps.history.list()) {
    if (entry.id.startsWith(SYNC_PREFIX) || meta.uploaded[entry.id]) continue;
    if (!meta.importPending && entry.createdAt < meta.pushSince) continue;
    const entryId = await entryUuid(entry.id, deps.deviceId);
    const item = await encryptItem(key, entryId, v, payloadOf(entry));
    await deps.api.addHistoryEntry({ entry_id: entryId, key_version: v, ...itemToWire(item) });
    meta.uploaded[entry.id] = entryId;
    pushed++;
  }
  meta.importPending = false;
  return pushed;
}

/**
 * P2-9: entries skipped as unreadable are pulled again once the device holds a key version it lacked when it skipped
 * them: the cursor moves back to just before the lowest skipped `seq`.
 */
export function rewindForNewKeys(meta: AccountSyncMeta, held: readonly number[]): boolean {
  if (meta.retrySeq === null || !held.some((v) => !meta.retryVersions.includes(v))) return false;
  meta.cursor = Math.min(meta.cursor, Math.max(0, meta.retrySeq - 1));
  meta.retrySeq = null;
  meta.retryVersions = [];
  return true;
}

function skipped(meta: AccountSyncMeta, seq: number, held: readonly number[], result: SyncResult) {
  result.unreadable++;
  meta.retrySeq = meta.retrySeq === null ? seq : Math.min(meta.retrySeq, seq);
  meta.retryVersions = [...held];
}

async function pull(deps: SyncDeps, meta: AccountSyncMeta, result: SyncResult) {
  if (!deps.enabled) return;
  const held = await deps.keys.allVersions();
  rewindForNewKeys(meta, held);
  const mine = new Map(Object.entries(meta.uploaded).map(([local, remote]) => [remote, local]));
  for (let page = 0; page < 50; page++) {
    const { entries, next_after } = await deps.api.historyEntries(meta.cursor);
    if (!entries.length) return;
    for (const e of entries) {
      const local = mine.get(e.entry_id);
      if (e.deleted) {
        // Deleted on any device: gone here too (the store also remembers it, so it is not recorded again).
        if (local) {
          await deps.history.remove(local);
          meta.uploaded = omit(meta.uploaded, [local]);
          result.removed++;
        }
        await deps.history.remove(syncedId(e.entry_id));
        continue;
      }
      if (local || e.origin_device_id === deps.deviceId || !e.nonce || !e.ciphertext) continue;
      if (!(await deps.keys.hasAdk(e.key_version))) {
        skipped(meta, e.seq, held, result);
        continue;
      }
      let text: string;
      try {
        const key = await deps.keys.loadSubkeys(e.key_version, 'history');
        text = await decryptItemText(
          key,
          e.entry_id,
          e.key_version,
          itemFromWire({ nonce: e.nonce, ciphertext: e.ciphertext }),
        );
      } catch {
        skipped(meta, e.seq, held, result);
        continue;
      }
      const parsed = parseEntry(text);
      if (!parsed) {
        skipped(meta, e.seq, held, result);
        continue;
      }
      const origin = deps.deviceNames?.get(e.origin_device_id);
      await deps.history.add({ ...parsed, id: syncedId(e.entry_id), ...(origin ? { origin } : {}) });
      result.pulled++;
    }
    meta.cursor = next_after;
    await deps.meta.put(meta);
  }
}

/**
 * One sync pass: send deletions made offline, upload local entries (new ones while sync is on, every one once
 * after "Copy this device's transfer history"), then pull everything after the cursor, applying tombstones and
 * decrypting new entries into the local History. Errors propagate after the bookkeeping that already succeeded
 * is saved, so the next pass continues where this one stopped.
 */
export async function syncHistory(deps: SyncDeps): Promise<SyncResult> {
  const meta = await deps.meta.get(deps.userId);
  const result: SyncResult = { pushed: 0, pulled: 0, removed: 0, unreadable: 0 };
  try {
    await flushDeletes(deps, meta);
    result.pushed = await push(deps, meta);
    await pull(deps, meta, result);
  } finally {
    await deps.meta.put(meta);
  }
  return result;
}

/**
 * A local deletion: tombstones the matching server entry (an entry pulled from the account, or one this device
 * uploaded). Offline, the deletion waits in the bookkeeping for the next sync pass.
 */
export async function deleteSynced(deps: Pick<SyncDeps, 'api' | 'meta' | 'userId'>, localIds: string[]) {
  const meta = await deps.meta.get(deps.userId);
  const remote = localIds
    .map((id) => (id.startsWith(SYNC_PREFIX) ? id.slice(SYNC_PREFIX.length) : meta.uploaded[id]))
    .filter((id): id is string => !!id);
  meta.uploaded = omit(meta.uploaded, localIds);
  meta.pendingDeletes = [...new Set([...meta.pendingDeletes, ...remote])];
  await deps.meta.put(meta);
  try {
    await flushDeletes({ ...(deps as SyncDeps) }, meta);
  } finally {
    await deps.meta.put(meta);
  }
}

/** "Clear all" while syncing: tombstones the whole account history (queued when offline). */
export async function clearSynced(deps: Pick<SyncDeps, 'api' | 'meta' | 'userId'>) {
  const meta = await deps.meta.get(deps.userId);
  meta.pendingClear = true;
  meta.uploaded = {};
  await deps.meta.put(meta);
  try {
    await flushDeletes({ ...(deps as SyncDeps) }, meta);
  } finally {
    await deps.meta.put(meta);
  }
}
