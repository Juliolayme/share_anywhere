// Receiver progress across reloads (docs/TRANSFER_PROTOCOL.md §4): the completed-block bitmap of each
// transfer, keyed by the hash of the transfer capability and the transfer ID, plus the save target chosen
// for a session. Nothing here is sent anywhere.

export type SaveMode = 'folder' | 'opfs' | 'memory';

export interface Progress {
  key: string;
  sessionId: string;
  transferId: string;
  name: string;
  size: number;
  blockSize: number;
  bitmap: Uint8Array;
  /** OPFS staging file name (folder and opfs modes). */
  staging: string;
  verified: boolean;
  /** Set once a verified file was copied into the chosen folder. */
  savedToFolder?: boolean;
  updatedAt: number;
}

export interface SaveTarget {
  sessionId: string;
  mode: SaveMode;
  folder?: FileSystemDirectoryHandle;
  folderName?: string;
}

export interface ProgressStore {
  get(key: string): Promise<Progress | undefined>;
  all(): Promise<Progress[]>;
  remove(key: string): Promise<void>;
  put(p: Progress): Promise<void>;
  forSession(sessionId: string): Promise<Progress[]>;
  removeSession(sessionId: string): Promise<void>;
  getTarget(sessionId: string): Promise<SaveTarget | undefined>;
  putTarget(t: SaveTarget): Promise<void>;
}

const DB = 'share-anywhere-transfers';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function progressKey(capabilityHash: string, transferId: string): string {
  return `${capabilityHash}:${transferId}`;
}

export function openProgressStore(factory: IDBFactory = indexedDB): ProgressStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const r = factory.open(DB, 1);
      r.onupgradeneeded = () => {
        const p = r.result.createObjectStore('progress', { keyPath: 'key' });
        p.createIndex('session', 'sessionId');
        r.result.createObjectStore('targets', { keyPath: 'sessionId' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const store = async (name: string, mode: IDBTransactionMode) =>
    (await open()).transaction(name, mode).objectStore(name);
  return {
    get: async (key) => req<Progress | undefined>((await store('progress', 'readonly')).get(key)),
    all: async () => req<Progress[]>((await store('progress', 'readonly')).getAll()),
    remove: async (key) => void (await req((await store('progress', 'readwrite')).delete(key))),
    put: async (p) => void (await req((await store('progress', 'readwrite')).put(p))),
    forSession: async (sessionId) =>
      req<Progress[]>((await store('progress', 'readonly')).index('session').getAll(sessionId)),
    removeSession: async (sessionId) => {
      const tx = (await open()).transaction(['progress', 'targets'], 'readwrite');
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      });
      // Delete inside request callbacks so the transaction stays active until the last delete.
      const cursor = tx.objectStore('progress').index('session').openKeyCursor(IDBKeyRange.only(sessionId));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        tx.objectStore('progress').delete(c.primaryKey);
        c.continue();
      };
      tx.objectStore('targets').delete(sessionId);
      await done;
    },
    getTarget: async (sessionId) => req<SaveTarget | undefined>((await store('targets', 'readonly')).get(sessionId)),
    putTarget: async (t) => void (await req((await store('targets', 'readwrite')).put(t))),
  };
}
