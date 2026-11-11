import type { RemoteClipboardEvent } from './api';

/**
 * Clipboard Sync data kept in this browser (docs/CLIPBOARD_PROTOCOL.md §2.8), in IndexedDB `share-anywhere-clipboard`:
 * - `events`: the account's live events exactly as the server sent them (ciphertext only, never plaintext), so the
 *   timeline opens offline; decrypted in memory when shown;
 * - `queue`: captures encrypted on this device and not yet acknowledged by the server (the offline queue);
 * - `meta`: the account's `seq` cursor (the highest seq applied) and when it last caught up.
 * Records carry the account ID, and everything is erased with the key store when the device leaves the account.
 * Never in Web Storage.
 */
export interface CachedEvent extends RemoteClipboardEvent {
  userId: string;
}

export interface QueuedEvent {
  userId: string;
  event_id: string;
  key_version: number;
  nonce: string;
  ciphertext: string;
  payload_size: number;
  /** Epoch ms when it was captured here (orders the queue and the pending rows). */
  queuedAt: number;
}

export interface ClipboardStore {
  events(userId: string): Promise<CachedEvent[]>;
  /** One transaction: upserts `put`, deletes `remove`, and moves the cursor (never backwards) when given. */
  apply(userId: string, change: { put?: RemoteClipboardEvent[]; remove?: string[]; cursor?: number }): Promise<void>;
  /** Replaces every cached event of the account and sets the cursor (initial load from `GET /v1/clipboard/history`). */
  replace(userId: string, events: RemoteClipboardEvent[], cursor: number): Promise<void>;
  cursor(userId: string): Promise<number | null>;
  /** Epoch ms of the last successful pass from the server (`apply` with a cursor, or `replace`), or null. */
  syncedAt(userId: string): Promise<number | null>;
  queue(userId: string): Promise<QueuedEvent[]>;
  enqueue(item: QueuedEvent): Promise<void>;
  dequeue(userId: string, eventId: string): Promise<void>;
  /** Erases every record of every account (sign-out, session end, key wipe). */
  wipe(): Promise<void>;
  /** Bumped by every wipe: a runtime started before it must not write again (see ClipboardEngine). */
  generation(): number;
}

export const CLIPBOARD_DB = 'share-anywhere-clipboard';
const EVENTS = 'events';
const QUEUE = 'queue';
const META = 'meta';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

const range = (userId: string) => IDBKeyRange.bound([userId, ''], [userId, '￿']);

export function openClipboardStore(factory: IDBFactory = indexedDB): ClipboardStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(CLIPBOARD_DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(EVENTS, { keyPath: ['userId', 'event_id'] });
        r.result.createObjectStore(QUEUE, { keyPath: ['userId', 'event_id'] });
        r.result.createObjectStore(META);
      };
      r.onsuccess = () => {
        // Another tab deleting or upgrading the database closes this connection; the next call reopens it.
        r.result.onversionchange = () => {
          r.result.close();
          dbp = null;
        };
        resolve(r.result);
      };
      r.onerror = () => {
        dbp = null;
        reject(r.error);
      };
    }));

  let wipes = 0;
  const cursorKey = (userId: string) => `cursor:${userId}`;
  const syncedKey = (userId: string) => `synced:${userId}`;

  /** Moves the cursor forward inside the caller's transaction (plain callbacks keep the transaction active). */
  const writeCursor = (store: IDBObjectStore, userId: string, cursor: number) => {
    const get = store.get(cursorKey(userId)) as IDBRequest<unknown>;
    get.onsuccess = () => {
      const prev = typeof get.result === 'number' ? get.result : -1;
      if (cursor > prev) store.put(cursor, cursorKey(userId));
    };
  };

  return {
    async events(userId) {
      const tx = (await db()).transaction(EVENTS, 'readonly');
      return req(tx.objectStore(EVENTS).getAll(range(userId)) as IDBRequest<CachedEvent[]>);
    },
    async apply(userId, change) {
      const tx = (await db()).transaction([EVENTS, META], 'readwrite');
      const events = tx.objectStore(EVENTS);
      for (const id of change.remove ?? []) events.delete([userId, id]);
      for (const e of change.put ?? []) events.put({ ...e, userId });
      if (change.cursor !== undefined) {
        writeCursor(tx.objectStore(META), userId, change.cursor);
        tx.objectStore(META).put(Date.now(), syncedKey(userId));
      }
      await done(tx);
    },
    async replace(userId, list, cursor) {
      const tx = (await db()).transaction([EVENTS, META], 'readwrite');
      const events = tx.objectStore(EVENTS);
      events.delete(range(userId));
      for (const e of list) events.put({ ...e, userId });
      tx.objectStore(META).put(cursor, cursorKey(userId));
      tx.objectStore(META).put(Date.now(), syncedKey(userId));
      await done(tx);
    },
    async syncedAt(userId) {
      const tx = (await db()).transaction(META, 'readonly');
      const v = await req(tx.objectStore(META).get(syncedKey(userId)) as IDBRequest<unknown>);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },
    async cursor(userId) {
      const tx = (await db()).transaction(META, 'readonly');
      const v = await req(tx.objectStore(META).get(cursorKey(userId)) as IDBRequest<unknown>);
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    },
    async queue(userId) {
      const tx = (await db()).transaction(QUEUE, 'readonly');
      const all = await req(tx.objectStore(QUEUE).getAll(range(userId)) as IDBRequest<QueuedEvent[]>);
      return all.sort((a, b) => a.queuedAt - b.queuedAt);
    },
    async enqueue(item) {
      const tx = (await db()).transaction(QUEUE, 'readwrite');
      tx.objectStore(QUEUE).put(item);
      await done(tx);
    },
    async dequeue(userId, eventId) {
      const tx = (await db()).transaction(QUEUE, 'readwrite');
      tx.objectStore(QUEUE).delete([userId, eventId]);
      await done(tx);
    },
    generation: () => wipes,
    async wipe() {
      wipes++;
      const tx = (await db()).transaction([EVENTS, QUEUE, META], 'readwrite');
      for (const s of [EVENTS, QUEUE, META]) tx.objectStore(s).clear();
      await done(tx);
    },
  };
}

let shared: ClipboardStore | null = null;

/** The clipboard store of this tab, opened once (the runtime and the account wipe share it). */
export function clipboardStore(): ClipboardStore {
  shared ??= openClipboardStore();
  return shared;
}
