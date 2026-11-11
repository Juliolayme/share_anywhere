import type { RemoteClipboardEvent } from './api';

/**
 * Clipboard Sync data kept in this browser (docs/CLIPBOARD_PROTOCOL.md §2.9), in IndexedDB `share-anywhere-clipboard`:
 * - `events`: the account's live events exactly as the server sent them (ciphertext only, never plaintext), so the
 *   timeline opens offline; decrypted in memory when shown;
 * - `queue`: captures encrypted on this device and not yet acknowledged by the server (the offline queue);
 * - `meta`: the account's `seq` cursor (the highest seq applied to `events`), when it last caught up, the store
 *   generation, and the pending deletes: events deleted on this device whose `DELETE` is not confirmed yet (§2.9).
 * Records carry the account ID, and everything is erased with the key store when the device leaves the account.
 * Never in Web Storage.
 *
 * Every tab of the browser shares these records, and each tab keeps its own timeline in memory (§2.9). The cache and
 * the cursor move together: `advance` writes a page pulled by cursor and moves the cursor in one transaction, and only
 * when the stored cursor still equals the cursor the page was pulled from, so the cache always holds every change up to
 * the stored cursor, and a page only ever moves it forward (`replace`, a history load, may set an older cursor over a
 * stale one, §2.9). A tab whose pull lost that race reloads its timeline from
 * the pair (`snapshot`, one read) and pulls on from there. A row enters the cache only through `advance`, `replace`
 * (the initial load) or `ackCreate` (an acknowledged capture whose seq is beyond the cursor); removals may happen at any
 * time, since the cursor brings the same tombstone later.
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
 * An event deleted on this device that may exist on the server (it was queued, so its create may have reached the
 * server or still be in flight in some tab). The `DELETE` is retried with the queue until it answers 204, or 404 once
 * `at + DELETE_GRACE_MS` has passed (docs/CLIPBOARD_PROTOCOL.md §2.9).
 */
export interface PendingDelete {
  userId: string;
  event_id: string;
  /** Epoch ms when it was deleted here. */
  at: number;
  /** Epoch ms of the next attempt. */
  due: number;
}

/** The cache, queue, pending deletes and cursor of one account, read in one transaction. */
export interface StoreSnapshot {
  events: CachedEvent[];
  queue: QueuedEvent[];
  deletes: PendingDelete[];
  cursor: number | null;
  /** Epoch ms of the last successful pass from the server, or null. */
  syncedAt: number | null;
}

/**
 * What `ackCreate` found for an acknowledged capture: `live` (dequeued; the row is cached, or its seq is beyond the
 * cursor and it was cached now), `gone` (dequeued; the cursor already passed its seq and the row is not cached: another
 * tab pulled its tombstone), `taken` (no longer in the queue: another tab acknowledged, deleted or cleared it; nothing
 * written), `deleted` (a pending delete exists for it; nothing written).
 */
export type AckState = 'live' | 'gone' | 'taken' | 'deleted';

/**
 * Write methods take the generation the caller read with `generation()`. They resolve `false` without writing anything
 * when a wipe (in any tab) replaced the generation since, and otherwise `true` (or their result).
 */
export interface ClipboardStore {
  events(userId: string): Promise<CachedEvent[]>;
  /** One read of everything a tab needs to (re)build its timeline: the cache and the cursor always agree. */
  snapshot(userId: string): Promise<StoreSnapshot>;
  /** Removes cached events (deleted on this device, or cleared). Never adds a row. */
  removeEvents(userId: string, ids: string[], gen: string): Promise<boolean>;
  /**
   * One transaction: when the stored cursor still equals `from`, deletes `remove`, upserts `put`, moves the cursor to
   * `to` (never backwards) and records the catch-up time, and resolves `ok`; otherwise (another tab moved it, or there
   * is none) writes nothing and resolves `moved`.
   */
  advance(
    userId: string,
    change: { put?: RemoteClipboardEvent[]; remove?: string[]; from: number; to: number },
    gen: string,
  ): Promise<'ok' | 'moved' | false>;
  /**
   * Replaces every cached event of the account and sets the cursor (initial load from `GET /v1/clipboard/history`),
   * unless another tab already stored a newer cursor caught up after `staleBefore` (epoch ms; default: never stale).
   */
  replace(
    userId: string,
    events: RemoteClipboardEvent[],
    cursor: number,
    gen: string,
    staleBefore?: number,
  ): Promise<boolean>;
  /**
   * One transaction for an acknowledged create (`201`): checks the queue, the pending deletes and the cursor, and
   * dequeues and caches the row only as `AckState` describes.
   */
  ackCreate(userId: string, event: RemoteClipboardEvent, gen: string): Promise<AckState | false>;
  cursor(userId: string): Promise<number | null>;
  /** The stored cursor and when it last caught up (epoch ms), read together. */
  syncState(userId: string): Promise<{ cursor: number | null; syncedAt: number | null }>;
  queue(userId: string): Promise<QueuedEvent[]>;
  enqueue(item: QueuedEvent, gen: string): Promise<boolean>;
  dequeue(userId: string, eventId: string, gen: string): Promise<boolean>;
  /** Pending deletes of the account. */
  deletes(userId: string): Promise<PendingDelete[]>;
  /**
   * One transaction per call: stores (or updates) each pending delete and drops the same event from the queue and the
   * cache, so a deleted capture is never in the queue and never shown again, in any tab.
   */
  markDeleted(userId: string, items: PendingDelete[], gen: string): Promise<boolean>;
  /** The `DELETE` was confirmed: forgets the pending delete. */
  forgetDelete(userId: string, eventId: string, gen: string): Promise<boolean>;
  /** Whether the event is still in the queue and whether it has a pending delete (another tab may have changed both). */
  pendingState(userId: string, eventId: string): Promise<{ queued: boolean; deleted: boolean }>;
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
  const deleteKey = (userId: string, eventId: string) => `delete:${userId}:${eventId}`;
  const deleteRange = (userId: string) => IDBKeyRange.bound(`delete:${userId}:`, `delete:${userId}:￿`);

  const asCursor = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const asTime = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const validDeletes = (userId: string, all: PendingDelete[]) =>
    all.filter((d) => d && typeof d.event_id === 'string' && d.userId === userId);

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

  /** `guarded` for a write that decides inside its transaction and reports what it did. */
  const decide = async <T>(
    stores: string[],
    gen: string,
    write: (tx: IDBTransaction, result: (v: T) => void) => void,
  ): Promise<T | false> => {
    let out: T | undefined;
    const wrote = await guarded(stores, gen, (tx) => write(tx, (v) => (out = v)));
    if (!wrote || out === undefined) return false;
    return out;
  };

  return {
    async events(userId) {
      const tx = (await db()).transaction(EVENTS, 'readonly');
      return req(tx.objectStore(EVENTS).getAll(range(userId)) as IDBRequest<CachedEvent[]>);
    },
    async snapshot(userId) {
      const tx = (await db()).transaction([EVENTS, QUEUE, META], 'readonly');
      const meta = tx.objectStore(META);
      const [events, queue, deletes, cursor, synced] = await Promise.all([
        req(tx.objectStore(EVENTS).getAll(range(userId)) as IDBRequest<CachedEvent[]>),
        req(tx.objectStore(QUEUE).getAll(range(userId)) as IDBRequest<QueuedEvent[]>),
        req(meta.getAll(deleteRange(userId)) as IDBRequest<PendingDelete[]>),
        req(meta.get(cursorKey(userId)) as IDBRequest<unknown>),
        req(meta.get(syncedKey(userId)) as IDBRequest<unknown>),
      ]);
      return {
        events,
        queue: queue.sort((a, b) => a.queuedAt - b.queuedAt),
        deletes: validDeletes(userId, deletes),
        cursor: asCursor(cursor),
        syncedAt: asTime(synced),
      };
    },
    removeEvents(userId, ids, gen) {
      return guarded([EVENTS], gen, (tx) => {
        for (const id of ids) tx.objectStore(EVENTS).delete([userId, id]);
      });
    },
    advance(userId, change, gen) {
      return decide<'ok' | 'moved'>([EVENTS], gen, (tx, result) => {
        const meta = tx.objectStore(META);
        const get = meta.get(cursorKey(userId)) as IDBRequest<unknown>;
        get.onsuccess = () => {
          if (asCursor(get.result) !== change.from || change.to < change.from) return result('moved');
          const events = tx.objectStore(EVENTS);
          for (const id of change.remove ?? []) events.delete([userId, id]);
          for (const e of change.put ?? []) events.put({ ...e, userId });
          meta.put(change.to, cursorKey(userId));
          meta.put(Date.now(), syncedKey(userId));
          result('ok');
        };
      });
    },
    replace(userId, list, cursor, gen, staleBefore = -Infinity) {
      return guarded([EVENTS], gen, (tx) => {
        const meta = tx.objectStore(META);
        const prev = meta.get(cursorKey(userId)) as IDBRequest<unknown>;
        const synced = meta.get(syncedKey(userId)) as IDBRequest<unknown>;
        synced.onsuccess = () => {
          const at = asTime(synced.result);
          const stored = asCursor(prev.result);
          // Another tab stored a newer pair since this load started: keep it (this tab reloads from it).
          if (stored !== null && stored > cursor && at !== null && at >= staleBefore) return;
          const events = tx.objectStore(EVENTS);
          events.delete(range(userId));
          for (const e of list) events.put({ ...e, userId });
          meta.put(cursor, cursorKey(userId));
          meta.put(Date.now(), syncedKey(userId));
        };
      });
    },
    ackCreate(userId, event, gen) {
      return decide<AckState>([QUEUE, EVENTS], gen, (tx, result) => {
        const id = event.event_id;
        const meta = tx.objectStore(META);
        const queued = tx.objectStore(QUEUE).getKey([userId, id]);
        const deleted = meta.getKey(deleteKey(userId, id));
        const cursor = meta.get(cursorKey(userId)) as IDBRequest<unknown>;
        const cached = tx.objectStore(EVENTS).getKey([userId, id]);
        // Requests complete in order: every result is known in the last callback.
        cached.onsuccess = () => {
          if (deleted.result !== undefined) return result('deleted');
          if (queued.result === undefined) return result('taken');
          tx.objectStore(QUEUE).delete([userId, id]);
          const stored = asCursor(cursor.result);
          if (stored !== null && stored >= event.seq) return result(cached.result !== undefined ? 'live' : 'gone');
          tx.objectStore(EVENTS).put({ ...event, userId });
          result('live');
        };
      });
    },
    async cursor(userId) {
      const tx = (await db()).transaction(META, 'readonly');
      return asCursor(await req(tx.objectStore(META).get(cursorKey(userId)) as IDBRequest<unknown>));
    },
    async syncState(userId) {
      const tx = (await db()).transaction(META, 'readonly');
      const [cursor, synced] = await Promise.all([
        req(tx.objectStore(META).get(cursorKey(userId)) as IDBRequest<unknown>),
        req(tx.objectStore(META).get(syncedKey(userId)) as IDBRequest<unknown>),
      ]);
      return { cursor: asCursor(cursor), syncedAt: asTime(synced) };
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
    async deletes(userId) {
      const tx = (await db()).transaction(META, 'readonly');
      return validDeletes(
        userId,
        await req(tx.objectStore(META).getAll(deleteRange(userId)) as IDBRequest<PendingDelete[]>),
      );
    },
    markDeleted(userId, items, gen) {
      return guarded([QUEUE, EVENTS], gen, (tx) => {
        for (const d of items) {
          tx.objectStore(QUEUE).delete([userId, d.event_id]);
          tx.objectStore(EVENTS).delete([userId, d.event_id]);
          tx.objectStore(META).put({ ...d, userId }, deleteKey(userId, d.event_id));
        }
      });
    },
    forgetDelete(userId, eventId, gen) {
      return guarded([], gen, (tx) => tx.objectStore(META).delete(deleteKey(userId, eventId)));
    },
    async pendingState(userId, eventId) {
      const tx = (await db()).transaction([QUEUE, META], 'readonly');
      const [q, d] = await Promise.all([
        req(tx.objectStore(QUEUE).getKey([userId, eventId])),
        req(tx.objectStore(META).getKey(deleteKey(userId, eventId))),
      ]);
      return { queued: q !== undefined, deleted: d !== undefined };
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
