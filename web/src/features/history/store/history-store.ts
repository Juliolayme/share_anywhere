// Local transfer history in IndexedDB (PRD §2 "History", docs/UX_SCREEN_MAP.md HI-1). Guest history never
// leaves this device; Phase 5A adds optional encrypted sync for signed-in users.

export type Direction = 'sent' | 'received';
export type HistoryStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export interface HistoryEntry {
  id: string;
  direction: Direction;
  /** Main file name, or a summary such as "3 files". */
  title: string;
  fileCount: number;
  totalBytes: number;
  /** Bytes that arrived (or were verified by the receiver) when the transfer ended short of totalBytes. */
  transferredBytes?: number;
  /** The other side's display name (receiver or sender). */
  peer: string;
  status: HistoryStatus;
  /** Epoch milliseconds when the transfer ended. */
  createdAt: number;
}

export type Retention = '30' | '90' | 'none';
export const RETENTION_DAYS: Record<Retention, number> = { '30': 30, '90': 90, none: 0 };
const DAY = 24 * 60 * 60 * 1000;

const DB_NAME = 'share-anywhere';
const STORE = 'history';

export interface HistoryStore {
  add(entry: HistoryEntry): Promise<void>;
  list(): Promise<HistoryEntry[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  /** Deletes entries older than the retention period; "none" deletes everything. Returns the count removed. */
  sweep(retention: Retention, now?: number): Promise<number>;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export function openHistoryStore(factory: IDBFactory = indexedDB): HistoryStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
    return dbPromise;
  };

  async function write(fn: (s: IDBObjectStore) => void): Promise<void> {
    const tx = (await db()).transaction(STORE, 'readwrite');
    fn(tx.objectStore(STORE));
    await done(tx);
  }

  return {
    add: (entry) => write((s) => s.put(entry)),
    async list() {
      const tx = (await db()).transaction(STORE, 'readonly');
      const all = await promisify(tx.objectStore(STORE).index('createdAt').getAll());
      return (all as HistoryEntry[]).reverse();
    },
    remove: (id) => write((s) => s.delete(id)),
    clear: () => write((s) => s.clear()),
    async sweep(retention, now = Date.now()) {
      const days = RETENTION_DAYS[retention];
      const tx = (await db()).transaction(STORE, 'readwrite');
      const index = tx.objectStore(STORE).index('createdAt');
      const range = days === 0 ? null : IDBKeyRange.upperBound(now - days * DAY, true);
      let removed = 0;
      await new Promise<void>((resolve, reject) => {
        const req = index.openCursor(range);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve();
          cursor.delete();
          removed++;
          cursor.continue();
        };
      });
      await done(tx);
      return removed;
    },
  };
}

/** Filters for the History screen (tabs, search, status, date range, peer). */
export interface HistoryFilter {
  tab: 'all' | Direction;
  query: string;
  status: 'any' | HistoryStatus;
  range: 'all' | '30d' | '7d' | 'today';
  peer: string; // '' = all devices
}

export function filterHistory(entries: HistoryEntry[], f: HistoryFilter, now = Date.now()): HistoryEntry[] {
  const q = f.query.trim().toLocaleLowerCase();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const since =
    f.range === 'today'
      ? startOfToday.getTime()
      : f.range === '7d'
        ? now - 7 * DAY
        : f.range === '30d'
          ? now - 30 * DAY
          : 0;
  return entries.filter(
    (e) =>
      (f.tab === 'all' || e.direction === f.tab) &&
      (f.status === 'any' || e.status === f.status) &&
      (!f.peer || e.peer === f.peer) &&
      e.createdAt >= since &&
      (!q || e.title.toLocaleLowerCase().includes(q) || e.peer.toLocaleLowerCase().includes(q)),
  );
}
