// Local transfer history in IndexedDB (PRD §2 "History", docs/UX_SCREEN_MAP.md HI-1). Guest history never
// leaves this device; Phase 5A adds optional encrypted sync for signed-in users.

export type Direction = 'sent' | 'received';
export type HistoryStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

/** One file of a history entry (optional; entries written before Phase 4 have only `title` and `fileCount`). */
export interface HistoryFile {
  name: string;
  size: number;
  /** Bytes that arrived or were verified when the transfer ended short of `size`. */
  transferredBytes?: number;
}

/** How the bytes travelled: one route for every receiver, or a mix (some direct, some relayed). */
export type HistoryRoute = 'direct' | 'relay' | 'mixed';

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
  // Optional fields (Phase 4). Older entries lack them and still render; the detail view hides what is missing.
  /** Each peer's display name when there were several receivers; `peer` stays the joined summary. */
  peers?: string[];
  /** Per-file names and sizes, for search by file name and the detail view. */
  files?: HistoryFile[];
  /** Route the transfer used, for the detail view. */
  route?: HistoryRoute;
  /** Epoch milliseconds when the first byte moved; with `createdAt` it gives the duration. */
  startedAt?: number;
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

export const EMPTY_FILTER: HistoryFilter = { tab: 'all', query: '', status: 'any', range: 'all', peer: '' };

/** The peers of an entry: the per-receiver list when recorded, else the single `peer` name. */
export function entryPeers(e: HistoryEntry): string[] {
  const list = e.peers?.filter((p) => p.trim() !== '');
  return list && list.length > 0 ? list : e.peer ? [e.peer] : [];
}

/** Every peer that appears in the entries, sorted for the device filter. */
export function historyPeers(entries: HistoryEntry[]): string[] {
  return [...new Set(entries.flatMap(entryPeers))].sort((a, b) => a.localeCompare(b));
}

/** Names a search matches: the entry title, every recorded file name, and every peer. */
function searchable(e: HistoryEntry): string[] {
  return [e.title, e.peer, ...entryPeers(e), ...(e.files ?? []).map((f) => f.name)];
}

/** Start of the date window for a range preset, in epoch ms (0 = no lower bound). */
export function rangeStart(range: HistoryFilter['range'], now = Date.now()): number {
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  return range === '7d' ? now - 7 * DAY : range === '30d' ? now - 30 * DAY : 0;
}

export function filterHistory(entries: HistoryEntry[], f: HistoryFilter, now = Date.now()): HistoryEntry[] {
  const q = f.query.trim().toLocaleLowerCase();
  const since = rangeStart(f.range, now);
  return entries.filter(
    (e) =>
      (f.tab === 'all' || e.direction === f.tab) &&
      (f.status === 'any' || e.status === f.status) &&
      (!f.peer || entryPeers(e).includes(f.peer)) &&
      e.createdAt >= since &&
      (!q || searchable(e).some((s) => s.toLocaleLowerCase().includes(q))),
  );
}

/** Bytes that moved: the recorded count, else the full size for a completed entry, else unknown. */
export function transferredOf(e: HistoryEntry): number | undefined {
  if (e.transferredBytes !== undefined) return e.transferredBytes;
  return e.status === 'completed' ? e.totalBytes : undefined;
}
