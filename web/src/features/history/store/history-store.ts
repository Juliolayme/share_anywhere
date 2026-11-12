// Local transfer history in IndexedDB (PRD §2 "History", docs/UX_SCREEN_MAP.md HI-1). Guest history never
// leaves this device; Phase 5A adds optional encrypted sync for signed-in users.
import { readPref, writePref } from '../../../lib/storage';

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
export type HistoryRoute = 'direct' | 'relay' | 'cloud' | 'mixed';

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
  /** Name of the account device this entry came from, for entries pulled by cloud history sync (Phase 5A). */
  origin?: string;
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

const REMOVED_KEY = 'history.removed';
const REMOVED_MAX = 500;
/** Longer than any session lives (72 h signed in), so a live session cannot outlast the memory of a deletion. */
const REMOVED_TTL = 7 * DAY;

/**
 * Ids the user deleted (one by one or with Clear all), kept in localStorage so a live session that rewrites its
 * entry (`tx:<session>`, docs/ARCHITECTURE.md §4.5) does not bring it back, in this tab or another, or after a
 * reload. Kept for REMOVED_TTL and bounded to the most recent REMOVED_MAX ids; without storage nothing is
 * remembered. The same id is a whole session (`tx:` or `rx:<session>`), so a later delivery in that session is
 * not recorded either (docs/UX_SCREEN_MAP.md HI-2).
 */
/** Where deleted ids are kept: the UI preference storage (src/lib/storage.ts), or nothing. */
export interface PrefStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

function removedIds(storage: PrefStorage | null) {
  const read = (): Record<string, number> => {
    try {
      const v = JSON.parse(storage?.read(REMOVED_KEY) ?? '{}') as unknown;
      return v && typeof v === 'object' ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  };
  return {
    has: (id: string) => {
      const at = read()[id];
      return at !== undefined && Date.now() - at < REMOVED_TTL;
    },
    add(ids: string[]) {
      if (!storage || !ids.length) return;
      const now = Date.now();
      const all = { ...read(), ...Object.fromEntries(ids.map((id) => [id, now])) };
      const kept = Object.entries(all)
        .filter(([, at]) => now - at < REMOVED_TTL)
        .sort((a, b) => b[1] - a[1])
        .slice(0, REMOVED_MAX);
      storage.write(REMOVED_KEY, JSON.stringify(Object.fromEntries(kept))); // ignores full or blocked storage
    },
  };
}

export function openHistoryStore(
  factory: IDBFactory = indexedDB,
  storage: PrefStorage | null = { read: readPref, write: writePref },
): HistoryStore {
  const removed = removedIds(storage);
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
    // An entry the user deleted is not written again (a live session rewriting its result).
    add: async (entry) => (removed.has(entry.id) ? undefined : write((s) => s.put(entry))),
    async list() {
      const tx = (await db()).transaction(STORE, 'readonly');
      const all = await promisify(tx.objectStore(STORE).index('createdAt').getAll());
      return (all as HistoryEntry[]).reverse();
    },
    async remove(id) {
      removed.add([id]);
      await write((s) => s.delete(id));
    },
    async clear() {
      const tx = (await db()).transaction(STORE, 'readonly');
      const ids = (await promisify(tx.objectStore(STORE).getAllKeys())) as string[];
      removed.add(ids);
      await write((s) => s.clear());
    },
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
