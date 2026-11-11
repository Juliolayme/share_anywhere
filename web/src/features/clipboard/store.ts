import type { RemoteClipboardEvent } from './api';

/**
 * Clipboard Sync data kept in this browser (docs/CLIPBOARD_PROTOCOL.md §2.8), in IndexedDB `share-anywhere-clipboard`:
 * - `events`: the account's live events exactly as the server sent them (ciphertext only, never plaintext), so the
 *   timeline opens offline; decrypted in memory when shown;
 * - `queue`: captures encrypted on this device and not yet acknowledged by the server (the offline queue);
 * - `meta`: the account's `seq` cursor (the highest seq applied), when it last caught up, and the store generation.
 * Records carry the account ID, and everything is erased with the key store when the device leaves the account.
 * Never in Web Storage.
 *
 * The generation is a random token kept in `meta` and replaced by every wipe in the wipe's own transaction. Writers
 * pass the token they read when they started, and each write checks it inside its write transaction: after a wipe in
 * any tab of this browser, a runtime started before it writes nothing (IndexedDB runs transactions on the same stores
 * one after another, so the check and the write cannot interleave with a wipe).
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

/**
 * Write methods take the generation the caller read with `generation()`. They resolve `true` when they wrote, and
 * `false` without writing anything when a wipe (in any tab) replaced the generation since.
 */
export interface ClipboardStore {
  events(userId: string): Promise<CachedEvent[]>;
  /** One transaction: upserts `put`, deletes `remove`, and moves the cursor (never backwards) when given. */
  apply(
    userId: string,
    change: { put?: RemoteClipboardEvent[]; remove?: string[]; cursor?: number },
    gen: string,
  ): Promise<boolean>;
  /** Replaces every cached event of the account and sets the cursor (initial load from `GET /v1/clipboard/history`). */
  replace(userId: string, events: RemoteClipboardEvent[], cursor: number, gen: string): Promise<boolean>;
  cursor(userId: string): Promise<number | null>;
  /** Epoch ms of the last successful pass from the server (`apply` with a cursor, or `replace`), or null. */
  syncedAt(userId: string): Promise<number | null>;
  queue(userId: string): Promise<QueuedEvent[]>;
  enqueue(item: QueuedEvent, gen: string): Promise<boolean>;
  dequeue(userId: string, eventId: string, gen: string): Promise<boolean>;
  /** Erases every record of every account (sign-out, session end, key wipe) and starts a new generation. */
  wipe(): Promise<void>;
  /**
   * The current generation token, shared by every tab of this browser (created on first use). A runtime reads it once
   * when it starts and passes it to every write.
   */
  generation(): Promise<string>;
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

const GENERATION = 'generation';
const newGeneration = () => crypto.randomUUID();

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

  /**
   * Runs `write` inside a readwrite transaction over `stores` (plus `meta`) only when the stored generation still equals
   * `gen`; the check and the writes share the transaction, so a wipe from another tab cannot slip in between.
   */
  const guarded = async (stores: string[], gen: string, write: (tx: IDBTransaction) => void): Promise<boolean> => {
    const tx = (await db()).transaction([...new Set([...stores, META])], 'readwrite');
    let wrote = false;
    const get = tx.objectStore(META).get(GENERATION) as IDBRequest<unknown>;
    get.onsuccess = () => {
      if (get.result !== gen) return;
      wrote = true;
      write(tx);
    };
    await done(tx);
    return wrote;
  };

  return {
    async events(userId) {
      const tx = (await db()).transaction(EVENTS, 'readonly');
      return req(tx.objectStore(EVENTS).getAll(range(userId)) as IDBRequest<CachedEvent[]>);
    },
    apply(userId, change, gen) {
      return guarded([EVENTS], gen, (tx) => {
        const events = tx.objectStore(EVENTS);
        for (const id of change.remove ?? []) events.delete([userId, id]);
        for (const e of change.put ?? []) events.put({ ...e, userId });
        if (change.cursor !== undefined) {
          writeCursor(tx.objectStore(META), userId, change.cursor);
          tx.objectStore(META).put(Date.now(), syncedKey(userId));
        }
      });
    },
    replace(userId, list, cursor, gen) {
      return guarded([EVENTS], gen, (tx) => {
        const events = tx.objectStore(EVENTS);
        events.delete(range(userId));
        for (const e of list) events.put({ ...e, userId });
        tx.objectStore(META).put(cursor, cursorKey(userId));
        tx.objectStore(META).put(Date.now(), syncedKey(userId));
      });
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
    enqueue(item, gen) {
      return guarded([QUEUE], gen, (tx) => tx.objectStore(QUEUE).put(item));
    },
    dequeue(userId, eventId, gen) {
      return guarded([QUEUE], gen, (tx) => tx.objectStore(QUEUE).delete([userId, eventId]));
    },
    async generation() {
      // Read-or-create in one readwrite transaction, so two tabs starting together agree on one token.
      const tx = (await db()).transaction(META, 'readwrite');
      const meta = tx.objectStore(META);
      let token = '';
      const get = meta.get(GENERATION) as IDBRequest<unknown>;
      get.onsuccess = () => {
        if (typeof get.result === 'string' && get.result) token = get.result;
        else meta.put((token = newGeneration()), GENERATION);
      };
      await done(tx);
      return token;
    },
    async wipe() {
      const tx = (await db()).transaction([EVENTS, QUEUE, META], 'readwrite');
      for (const s of [EVENTS, QUEUE, META]) tx.objectStore(s).clear();
      tx.objectStore(META).put(newGeneration(), GENERATION);
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
