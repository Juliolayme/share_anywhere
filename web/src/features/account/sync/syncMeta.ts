/**
 * Per-account sync bookkeeping in IndexedDB (`share-anywhere-sync`), next to the history database: the history
 * pull cursor, which local entries were uploaded under which `entry_id`, deletions waiting for the network, and
 * the one-time "copy this device's history" import. None of it is secret (no keys, no plaintext beyond entry
 * ids), and it is erased with the key store when the device leaves the account. Never in Web Storage.
 */
export interface AccountSyncMeta {
  userId: string;
  /** `next_after` of the last applied page of GET /v1/history/entries. */
  cursor: number;
  /** Local entry id → server `entry_id` for entries this device uploaded. */
  uploaded: Record<string, string>;
  /** Server entry ids deleted here while offline (DELETE /v1/history/entries/{id} pending). */
  pendingDeletes: string[];
  /** "Clear all" done here while offline (DELETE /v1/history pending). */
  pendingClear: boolean;
  /** The user chose "Copy this device's transfer history": upload every local entry once. */
  importPending: boolean;
  /** Entries newer than this (epoch ms) are uploaded while sync is on; older ones only through the import. */
  pushSince: number;
  /**
   * Lowest `seq` skipped as unreadable (a key version this device lacked, or a decrypt failure), or null. When the
   * device stores a key version it did not hold then (pickup, chain import, pairing, recovery), the next pass moves
   * the cursor back to just before it and pulls those entries again.
   */
  retrySeq: number | null;
  /** The ADK versions this device held when `retrySeq` was recorded. */
  retryVersions: number[];
}

export interface SyncMetaStore {
  get(userId: string): Promise<AccountSyncMeta>;
  put(meta: AccountSyncMeta): Promise<void>;
  /** The account whose keys this browser holds, if any. */
  owner(): Promise<string | null>;
  setOwner(userId: string | null): Promise<void>;
  /** Erases every record (the device left the account). */
  wipe(): Promise<void>;
}

const DB = 'share-anywhere-sync';
const STORE = 'kv';

export function emptyMeta(userId: string, now = Date.now()): AccountSyncMeta {
  return {
    userId,
    cursor: 0,
    uploaded: {},
    pendingDeletes: [],
    pendingClear: false,
    importPending: false,
    pushSince: now,
    retrySeq: null,
    retryVersions: [],
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openSyncMeta(factory: IDBFactory = indexedDB): SyncMetaStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        dbp = null;
        reject(r.error);
      };
    }));
  const get = async <T>(key: string): Promise<T | undefined> =>
    req((await db()).transaction(STORE, 'readonly').objectStore(STORE).get(key) as IDBRequest<T | undefined>);
  const write = async (fn: (s: IDBObjectStore) => void) => {
    const tx = (await db()).transaction(STORE, 'readwrite');
    fn(tx.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  };
  return {
    async get(userId) {
      return { ...emptyMeta(userId), ...((await get<AccountSyncMeta>(`acct:${userId}`)) ?? {}) };
    },
    put: (meta) => write((s) => s.put(meta, `acct:${meta.userId}`)),
    owner: async () => (await get<string>('owner')) ?? null,
    setOwner: (userId) => write((s) => (userId ? s.put(userId, 'owner') : s.delete('owner'))),
    wipe: () => write((s) => s.clear()),
  };
}
