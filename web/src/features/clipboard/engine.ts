// Clipboard Sync runtime for one account on this device (docs/CLIPBOARD_PROTOCOL.md §2, PRD §7.4–§7.6). Loaded on
// demand, only for a signed-in account whose device is added and holds the key. Holds the decrypted timeline in
// memory, the encrypted cache and offline queue in IndexedDB, and follows the account's `seq` cursor.
import {
  decryptItemText,
  encryptItem,
  itemFromWire,
  itemToWire,
  newItemId,
  toItemId,
  type KeyStore,
} from '../../lib/crypto';
import { ApiError, NetworkError } from '../../lib/api/errors';
import {
  MAX_EVENTS,
  MAX_PAYLOAD_BYTES,
  type ClipboardApi,
  type ClipboardSettings,
  type RemoteClipboardEvent,
} from './api';
import { sensitiveKind, type SensitiveKind } from './sensitive';
import type { AckState, ClipboardStore, PendingDelete, QueuedEvent, StoreSnapshot } from './store';

export type KeySource = Pick<KeyStore, 'currentVersion' | 'allVersions' | 'loadSubkeys'>;

export interface EngineDeps {
  api: ClipboardApi;
  keys: KeySource;
  store: ClipboardStore;
  userId: string;
  deviceId: string;
  /**
   * Runs a key check (picks up a rotation). Called when an upload is refused with `409 key_version_conflict`; the
   * queued event is then re-encrypted with the newest key and sent once more.
   */
  onKeyConflict?: () => Promise<unknown>;
  now?: () => number;
  /** New event ids; normalized to the lowercase canonical UUID text (docs/CLIPBOARD_PROTOCOL.md §1.3). */
  uuid?: () => string;
  /** Retry timer for the offline queue (tests inject a manual one). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** A timeline row. `text` is null when this device cannot decrypt it (a key version it does not hold). */
export interface ClipItem {
  id: string;
  /** Null while the event waits in the offline queue. */
  seq: number | null;
  origin: string;
  createdAt: number;
  expiresAt: number | null;
  size: number;
  keyVersion: number;
  text: string | null;
  pending: boolean;
  /** Arrived from another device while this tab was open, and not copied yet ("New"). */
  incoming: boolean;
}

/** A capture skipped on this device as possibly sensitive (automatic or in-page copy). Never stored or sent. */
export interface SkippedNotice {
  id: string;
  at: number;
  kind: SensitiveKind;
}

/**
 * Why the queue is not empty or an item was lost: `offline` (retried), `key` (the account's key moved on and this
 * device lacks it: pair again), `rate_limited` (retried later), `error` (server error, retried), `rejected` (the server
 * refused an item for good: too large or malformed; it was dropped).
 */
export type SendError = 'offline' | 'key' | 'rate_limited' | 'error' | 'rejected';

export interface ClipboardSnapshot {
  /** The cached timeline was read (it may still be refreshing). */
  loaded: boolean;
  /** A refresh from the server succeeded since this page started (an empty timeline is then really empty). */
  synced: boolean;
  /** The last refresh from the server failed (the cached timeline stays visible). */
  loadError: 'offline' | 'error' | null;
  /** A refresh from the server is running. */
  syncing: boolean;
  items: ClipItem[];
  skipped: SkippedNotice[];
  settings: ClipboardSettings | null;
  settingsError: boolean;
  queued: number;
  sendError: SendError | null;
  /** Events that could not be decrypted here. */
  unreadable: number;
}

export type CaptureSource = 'manual' | 'auto' | 'copy';

/**
 * Why a capture stayed in the queue, for the toast: `offline` (no network), `busy` (server error, retried),
 * `rate_limited` (429, retried after Retry-After), `key` (pair again), `paused` (sent when sync resumes), `pending`
 * (waiting for another reason, e.g. the account session is ending).
 */
export type QueueReason = 'offline' | 'busy' | 'rate_limited' | 'key' | 'paused' | 'pending';

export type CaptureResult =
  | { kind: 'synced'; id: string }
  | { kind: 'queued'; id: string; reason: QueueReason }
  | { kind: 'sensitive'; sensitive: SensitiveKind }
  | { kind: 'duplicate' | 'empty' | 'too_large' | 'paused' | 'not_ready' };

const utf8Length = (s: string) => new TextEncoder().encode(s).length;
const parseTime = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

const RETRY_MIN_MS = 5_000;
/** A cursor older than this is not followed: tombstones are swept after 7 days (one day of margin). */
const STALE_CURSOR_MS = 6 * 86_400_000;
const RETRY_MAX_MS = 60_000;
/**
 * How long a pending delete of a capture that was queued is kept after a `404` (docs/CLIPBOARD_PROTOCOL.md §2.9): a
 * create still in flight (in this tab or another) may land after the first `DELETE`, so a last `DELETE` is sent once
 * this has passed, and its 404 or 204 settles it.
 */
export const DELETE_GRACE_MS = 120_000;

export class ClipboardEngine {
  private readonly d: Required<Omit<EngineDeps, 'onKeyConflict'>> & Pick<EngineDeps, 'onKeyConflict'>;
  private listeners = new Set<() => void>();
  private snap: ClipboardSnapshot;
  /** Live events by id (server form) and their decrypted text (undefined: not tried yet). */
  private events = new Map<string, RemoteClipboardEvent>();
  private queued = new Map<string, QueuedEvent>();
  private texts = new Map<string, string | null>();
  private incoming = new Set<string>();
  private skipped: SkippedNotice[] = [];
  private settings: ClipboardSettings | null = null;
  private settingsError = false;
  private loaded = false;
  private synced = false;
  private loadError: ClipboardSnapshot['loadError'] = null;
  private sendError: SendError | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  /**
   * Events this page saw as tombstones. A queued event deleted elsewhere after its create reached the server (response
   * lost) is dropped from the queue, and a late acknowledgement for it never brings the row back.
   */
  private tombstoned = new Set<string>();
  /** Queued events that may already have reached the server (sent before, or queued by an earlier page). */
  private attempted = new Set<string>();
  /**
   * Events deleted on this device (here, in another tab, or read from the pending deletes at start). Only these get a
   * `DELETE` again when a late create acknowledgement or a pull shows them live; nothing else is ever deleted on the
   * server on this device's own initiative.
   */
  private deletedHere = new Set<string>();
  /** Pending deletes (the durable list in the store, §2.9): `DELETE`s not confirmed yet, retried with the queue. */
  private pendingDeletes = new Map<string, PendingDelete>();
  /** Queued events known to be in the store's queue: another tab may take them out (acknowledged, deleted, cleared). */
  private stored = new Set<string>();
  /** Clear history is running: nothing queued is sent until it is done. */
  private clearing = false;
  /**
   * The cursor this tab's timeline is applied up to (§2.9). It starts with the shared cache (one read) and moves only
   * with it: a page is written to the store only from the cursor stored there, and when another tab moved the stored
   * cursor, this tab reloads its timeline from the shared cache before pulling on.
   */
  private cursor: number | null = null;
  /** When the shared cursor this timeline follows last caught up (epoch ms). */
  private syncedAt: number | null = null;
  private retryTimer: unknown = null;
  private retryAt = 0;
  /** A refresh refused with 429 (reads are rate limited too) runs again after Retry-After. */
  private refreshTimer: unknown = null;
  private retryDelay = RETRY_MIN_MS;
  private lastText: string | null = null;
  private lastSkipped: string | null = null;
  private stopped = false;
  /** The store generation read at construction; null when it could not be read (then nothing is written). */
  private readonly generation: Promise<string | null>;
  /** A wipe (in this tab or another) replaced the generation: this engine writes nothing more. */
  private wiped = false;

  constructor(deps: EngineDeps) {
    this.d = {
      now: () => Date.now(),
      uuid: newItemId,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
    this.generation = this.d.store.generation().catch(() => null);
    this.snap = this.build();
  }

  get userId(): string {
    return this.d.userId;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): ClipboardSnapshot {
    return this.snap;
  }

  private emit() {
    if (this.stopped) return;
    this.snap = this.build();
    for (const l of this.listeners) l();
  }

  private build(): ClipboardSnapshot {
    const now = this.d.now();
    const items: ClipItem[] = [];
    for (const q of this.queued.values()) {
      if (this.events.has(q.event_id)) continue;
      items.push({
        id: q.event_id,
        seq: null,
        origin: this.d.deviceId,
        createdAt: q.queuedAt,
        expiresAt: null,
        size: q.payload_size,
        keyVersion: q.key_version,
        text: this.texts.get(q.event_id) ?? null,
        pending: true,
        incoming: false,
      });
    }
    const live = [...this.events.values()]
      .filter((e) => {
        const exp = parseTime(e.expires_at);
        return exp === null || exp > now;
      })
      .sort((a, b) => b.seq - a.seq)
      .slice(0, MAX_EVENTS);
    for (const e of live) {
      items.push({
        id: e.event_id,
        seq: e.seq,
        origin: e.origin_device_id,
        createdAt: parseTime(e.created_at) ?? now,
        expiresAt: parseTime(e.expires_at),
        size: e.payload_size,
        keyVersion: e.key_version,
        text: this.texts.get(e.event_id) ?? null,
        pending: false,
        incoming: this.incoming.has(e.event_id),
      });
    }
    items.sort((a, b) => (a.pending !== b.pending ? (a.pending ? -1 : 1) : b.createdAt - a.createdAt));
    return {
      loaded: this.loaded,
      synced: this.synced,
      loadError: this.loadError,
      syncing: this.refreshing !== null,
      items,
      skipped: [...this.skipped],
      settings: this.settings,
      settingsError: this.settingsError,
      queued: this.queued.size,
      sendError: this.sendError,
      unreadable: items.filter((i) => i.text === null).length,
    };
  }

  /**
   * Writes to the local store unless this engine was stopped or the store was wiped since it started, in this tab or
   * another one (sign-out or the account session ending while a request was in flight must not leave records behind).
   * The store checks the generation inside each write transaction. Storage errors are ignored: the cache and queue
   * are best effort, the server is the source of truth.
   */
  private async persist(fn: (s: ClipboardStore, gen: string) => Promise<boolean>): Promise<boolean> {
    if (this.stopped || this.wiped) return false;
    const gen = await this.generation;
    if (gen === null || this.stopped) return false;
    const wrote = await fn(this.d.store, gen).catch(() => null);
    if (wrote === false) this.wiped = true;
    return wrote === true;
  }

  /** `persist` for a write that reports what it did; null when nothing could be written (stopped, wiped, error). */
  private async persistResult<T>(fn: (s: ClipboardStore, gen: string) => Promise<T | false>): Promise<T | null> {
    let out: T | null = null;
    await this.persist(async (s, g) => {
      const r = await fn(s, g);
      if (r === false) return false;
      out = r;
      return true;
    });
    return out;
  }

  /** Reads the cache and the queue, then refreshes from the server, loads the settings and sends what is queued. */
  async start(): Promise<void> {
    try {
      const snap = await this.d.store.snapshot(this.d.userId);
      for (const q of snap.queue) {
        if (snap.deletes.some((d) => d.event_id === q.event_id)) continue;
        this.queued.set(q.event_id, q);
        this.attempted.add(q.event_id);
        this.stored.add(q.event_id);
      }
      await this.adopt(snap);
    } catch {
      /* the cache is a convenience: the server refresh below fills the timeline */
    }
    this.loaded = true;
    this.emit();
    await Promise.all([this.refresh(), this.loadSettings()]);
    void this.flush();
  }

  /**
   * Takes the shared cache and cursor (read together) as this tab's timeline, keeping what this tab knows: events
   * deleted here stay hidden, the pending deletes of every tab are added, and a queued capture that left the shared
   * queue meanwhile (acknowledged, deleted or cleared in another tab) leaves this tab's queue too.
   */
  private async adopt(snap: StoreSnapshot) {
    for (const d of snap.deletes) {
      if (!this.pendingDeletes.has(d.event_id)) this.pendingDeletes.set(d.event_id, d);
      this.deletedHere.add(d.event_id);
    }
    const next = new Map<string, RemoteClipboardEvent>();
    for (const e of snap.events) {
      if (!e.deleted && e.ciphertext && e.nonce && !this.deletedHere.has(e.event_id)) next.set(e.event_id, e);
    }
    if (this.loaded) {
      for (const [id, e] of next) {
        if (!this.events.has(id) && !this.queued.has(id) && e.origin_device_id !== this.d.deviceId)
          this.incoming.add(id);
      }
    }
    for (const id of [...this.incoming]) if (!next.has(id)) this.incoming.delete(id);
    this.events = next;
    this.cursor = snap.cursor;
    this.syncedAt = snap.syncedAt;
    const inQueue = new Set(snap.queue.map((q) => q.event_id));
    for (const id of [...this.queued.keys()]) {
      if (this.deletedHere.has(id) || (this.stored.has(id) && !inQueue.has(id))) {
        this.queued.delete(id);
        this.attempted.delete(id);
        this.stored.delete(id);
      } else if (this.events.has(id)) {
        await this.acked(id);
      }
    }
    for (const id of [...this.texts.keys()]) if (!this.events.has(id) && !this.queued.has(id)) this.texts.delete(id);
    await this.decryptMissing();
  }

  /** Reloads this tab's timeline from the shared cache (another tab moved the shared cursor). False when unreadable. */
  private async reload(): Promise<boolean> {
    const snap = await this.d.store.snapshot(this.d.userId).catch(() => null);
    if (!snap || this.stopped) return false;
    await this.adopt(snap);
    return true;
  }

  stop() {
    this.stopped = true;
    this.listeners.clear();
    if (this.retryTimer !== null) this.d.clearTimer(this.retryTimer);
    if (this.refreshTimer !== null) this.d.clearTimer(this.refreshTimer);
    this.retryTimer = null;
    this.refreshTimer = null;
  }

  private async decrypt(id: string, keyVersion: number, nonce: string, ciphertext: string): Promise<string | null> {
    try {
      const held = await this.d.keys.allVersions();
      if (!held.includes(keyVersion)) return null;
      const key = await this.d.keys.loadSubkeys(keyVersion, 'clipboard');
      return await decryptItemText(key, id, keyVersion, itemFromWire({ nonce, ciphertext }));
    } catch {
      return null;
    }
  }

  /** Decrypts every row not tried yet, and retries rows that were locked (after a key arrived). */
  private async decryptMissing(retryLocked = false) {
    for (const e of this.events.values()) {
      if (!e.nonce || !e.ciphertext) continue;
      const known = this.texts.get(e.event_id);
      if (known !== undefined && !(retryLocked && known === null)) continue;
      this.texts.set(e.event_id, await this.decrypt(e.event_id, e.key_version, e.nonce, e.ciphertext));
    }
    for (const q of this.queued.values()) {
      const known = this.texts.get(q.event_id);
      if (known !== undefined && !(retryLocked && known === null)) continue;
      this.texts.set(q.event_id, await this.decrypt(q.event_id, q.key_version, q.nonce, q.ciphertext));
    }
  }

  /** A key check stored new versions: rows that were locked are tried again, and the queue is sent. */
  async keysChanged(): Promise<void> {
    await this.decryptMissing(true);
    this.emit();
    if (this.sendError === 'key') this.sendError = null;
    void this.flush();
  }

  /**
   * Follows the account's cursor (`GET /v1/clipboard/events?cursor=`) until no newer event is left; the first time on
   * this device it loads the live timeline (`GET /v1/clipboard/history`). Concurrent calls coalesce into one more
   * pass, so a burst of WebSocket notifications costs at most two passes.
   */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = (async () => {
      do {
        this.refreshAgain = false;
        await this.pull();
      } while (this.refreshAgain && !this.stopped);
    })().finally(() => {
      this.refreshing = null;
      this.emit();
    });
    this.refreshing = run;
    this.emit();
    return run;
  }

  /**
   * One pass by cursor. The shared cursor is read first: when another tab moved it past this tab's timeline, the
   * timeline is reloaded from the shared cache, so no event or tombstone that tab pulled is missed here. Each page is
   * applied in memory and written to the store from the cursor it was pulled from; when another tab wrote first, this
   * tab takes the shared state and pulls on from it.
   */
  private async pull() {
    const { api, store, userId, deviceId } = this.d;
    try {
      const shared = await store.syncState(userId).catch(() => null);
      let cursor: number | null = shared ? shared.cursor : this.cursor;
      const syncedAt = shared ? shared.syncedAt : this.syncedAt;
      // Tombstones are kept 7 days (docs/CLIPBOARD_PROTOCOL.md §2.5): a device that has not caught up for longer may
      // have missed deletions, so it reloads the live timeline instead of following its old cursor.
      if (cursor !== null && (syncedAt === null || this.d.now() - syncedAt > STALE_CURSOR_MS)) cursor = null;
      if (cursor !== null && shared && shared.cursor !== this.cursor && !(await this.reload())) cursor = null;
      if (cursor === null) {
        const h = await api.history();
        const all = h.events.filter((e) => !e.deleted && e.ciphertext && e.nonce);
        const live = all.filter((e) => !this.deletedHere.has(e.event_id));
        await this.persist((s, g) => s.replace(userId, live, h.cursor, g, this.d.now() - STALE_CURSOR_MS));
        this.events = new Map(live.map((e) => [e.event_id, e]));
        this.cursor = h.cursor;
        this.syncedAt = this.d.now();
        if (live.length < all.length) {
          await this.deleteAgain(all.filter((e) => this.deletedHere.has(e.event_id)).map((e) => e.event_id));
        }
        for (const id of this.queued.keys()) if (this.events.has(id)) await this.acked(id);
      }
      for (let page = 0; page < 50 && this.cursor !== null && !this.stopped; page++) {
        const from: number = this.cursor;
        const { events, next_cursor } = await api.events(from);
        const put: RemoteClipboardEvent[] = [];
        const remove: string[] = [];
        const again: string[] = [];
        for (const e of events) {
          if (e.deleted || !e.ciphertext || !e.nonce) {
            remove.push(e.event_id);
            this.events.delete(e.event_id);
            this.incoming.delete(e.event_id);
            this.tombstoned.add(e.event_id);
            // Deleted on another device while still queued here (its create reached the server but the response was
            // lost): drop it, so the retry cannot bring it back.
            if (this.queued.has(e.event_id)) await this.dropQueued(e.event_id);
            // A tombstone confirms a pending delete (a repeated create never restores a deleted event).
            if (this.pendingDeletes.has(e.event_id)) await this.forgetDelete(e.event_id);
            this.texts.delete(e.event_id);
            continue;
          }
          if (this.deletedHere.has(e.event_id)) {
            // Deleted on this device, but live on the server (its create landed after the DELETE, or the DELETE is
            // still pending): never shown again, and the DELETE is sent (again).
            remove.push(e.event_id);
            again.push(e.event_id);
            continue;
          }
          put.push(e);
          const fresh = !this.events.has(e.event_id) && !this.queued.has(e.event_id);
          this.events.set(e.event_id, e);
          if (fresh && this.loaded && e.origin_device_id !== deviceId) this.incoming.add(e.event_id);
          if (this.queued.has(e.event_id)) await this.acked(e.event_id);
        }
        const next = Math.max(from, next_cursor, ...events.map((e) => e.seq));
        // An empty page still records the catch-up time (when the stored cursor is this one).
        const wrote = await this.persistResult((s, g) => s.advance(userId, { put, remove, from, to: next }, g));
        if (again.length) await this.deleteAgain(again);
        if (wrote === 'moved') {
          // Another tab wrote the shared cache first: take its state, and pull on from its cursor.
          if (await this.reload()) continue;
        }
        this.cursor = next;
        if (wrote === 'ok') this.syncedAt = this.d.now();
        if (!events.length || next <= from) break;
      }
      await this.decryptMissing();
      this.loadError = null;
      this.synced = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        // Reads are rate limited (600/min per device): like the other 429s, try again after Retry-After. The state
        // stays what it was (loading, or the cached timeline), it is not reported as a failure.
        this.scheduleRefresh((e.retryAfterS ?? 5) * 1000);
        return;
      }
      this.loadError = e instanceof NetworkError ? 'offline' : 'error';
    }
  }

  private scheduleRefresh(ms: number) {
    if (this.stopped || this.refreshTimer !== null) return;
    this.refreshTimer = this.d.setTimer(
      () => {
        this.refreshTimer = null;
        void this.refresh();
      },
      Math.min(Math.max(ms, 1000), RETRY_MAX_MS),
    );
  }

  private async acked(id: string) {
    const text = this.texts.get(id);
    this.queued.delete(id);
    this.stored.delete(id);
    if (text !== undefined) this.texts.set(id, text);
    await this.persist((s, g) => s.dequeue(this.d.userId, id, g));
  }

  /** Drops a queued event locally (never sent again). */
  private async dropQueued(id: string) {
    this.queued.delete(id);
    this.attempted.delete(id);
    this.stored.delete(id);
    await this.persist((s, g) => s.dequeue(this.d.userId, id, g));
  }

  /**
   * Records events as deleted on this device: out of the queue, the cache and the timeline, and into the durable
   * pending deletes (one store transaction), whose `DELETE` is sent once `due` has come (§2.9).
   */
  private async markDeleted(ids: string[], due: number) {
    if (!ids.length) return;
    const now = this.d.now();
    const items: PendingDelete[] = ids.map((id) => ({
      userId: this.d.userId,
      event_id: id,
      at: this.pendingDeletes.get(id)?.at ?? now,
      due,
    }));
    for (const d of items) {
      const id = d.event_id;
      this.pendingDeletes.set(id, d);
      this.deletedHere.add(id);
      this.queued.delete(id);
      this.attempted.delete(id);
      this.stored.delete(id);
      this.events.delete(id);
      this.texts.delete(id);
      this.incoming.delete(id);
    }
    await this.persist((s, g) => s.markDeleted(this.d.userId, items, g));
  }

  /** An event deleted here showed up live: its `DELETE` is due now. */
  private async deleteAgain(ids: string[]) {
    await this.markDeleted(ids, this.d.now());
    void this.flush();
  }

  /** The server confirmed a pending delete (204, a settled 404, or its tombstone). */
  private async forgetDelete(id: string) {
    this.pendingDeletes.delete(id);
    await this.persist((s, g) => s.forgetDelete(this.d.userId, id, g));
  }

  async loadSettings(): Promise<void> {
    try {
      this.settings = await this.d.api.settings();
      this.settingsError = false;
    } catch {
      this.settingsError = true;
    }
    this.emit();
  }

  /** `CLIPBOARD_SETTINGS_UPDATED` from another device (metadata only). */
  applySettings(s: ClipboardSettings) {
    const resumed = this.settings?.paused === true && !s.paused;
    this.settings = s;
    this.settingsError = false;
    this.emit();
    if (resumed) void this.flush();
  }

  async saveSettings(next: ClipboardSettings): Promise<ClipboardSettings> {
    const stored = await this.d.api.saveSettings(next);
    this.applySettings(stored);
    return stored;
  }

  /** The newest text this tab saw on the clipboard (captured, read, or written by Copy): repeats are not synced. */
  noteClipboardText(text: string) {
    this.lastText = text;
  }

  /**
   * Identical consecutive text is not synced twice: the newest row already holds it, or (automatic and in-page
   * captures) this tab already saw it on the clipboard or skipped it as possibly sensitive.
   */
  private isDuplicate(text: string, source: CaptureSource): boolean {
    const newest = this.snap.items.find((i) => i.text !== null);
    if (newest?.text === text) return true;
    return source !== 'manual' && (text === this.lastText || text === this.lastSkipped);
  }

  /**
   * Encrypts and sends one capture. Manual Sync passes `force` after the user chose "Sync anyway" on a capture skipped
   * as possibly sensitive. Automatic and in-page captures that look sensitive are skipped and noted (never stored).
   */
  async capture(text: string, source: CaptureSource, force = false): Promise<CaptureResult> {
    if (this.stopped) return { kind: 'not_ready' };
    if (!text.trim()) return { kind: 'empty' };
    if (this.settings?.paused) return { kind: 'paused' };
    if (utf8Length(text) > MAX_PAYLOAD_BYTES) return { kind: 'too_large' };
    if (this.isDuplicate(text, source)) return { kind: 'duplicate' };
    const skipSensitive = this.settings?.sensitive_skip ?? true;
    const sensitive = skipSensitive && !force ? sensitiveKind(text) : null;
    if (sensitive) {
      if (source !== 'manual') {
        this.lastSkipped = text;
        this.skipped = [{ id: this.d.uuid(), at: this.d.now(), kind: sensitive }, ...this.skipped].slice(0, 20);
        this.emit();
      }
      return { kind: 'sensitive', sensitive };
    }
    const version = await this.d.keys.currentVersion();
    if (version <= 0) return { kind: 'not_ready' };
    // Lowercase canonical UUID text: the exact AAD and wire form (the server rejects any other form with 400).
    const id = toItemId(this.d.uuid());
    const key = await this.d.keys.loadSubkeys(version, 'clipboard');
    const wire = itemToWire(await encryptItem(key, id, version, text));
    const item: QueuedEvent = {
      userId: this.d.userId,
      event_id: id,
      key_version: version,
      ...wire,
      payload_size: utf8Length(text),
      queuedAt: this.d.now(),
    };
    this.lastText = text;
    this.texts.set(id, text);
    this.queued.set(id, item);
    if (await this.persist((s, g) => s.enqueue(item, g))) this.stored.add(id);
    this.emit();
    await this.flush();
    return this.queued.has(id) ? { kind: 'queued', id, reason: this.queueReason() } : { kind: 'synced', id };
  }

  /** The real reason the queue is waiting (offline versus server busy, rate limited, key, paused). */
  private queueReason(): QueueReason {
    if (this.settings?.paused) return 'paused';
    switch (this.sendError) {
      case 'offline':
        return 'offline';
      case 'rate_limited':
        return 'rate_limited';
      case 'error':
        return 'busy';
      case 'key':
        return 'key';
      default:
        return 'pending';
    }
  }

  /**
   * Sends queued events in capture order. Idempotent by `event_id`, so a retry never duplicates an event. A call while
   * a pass runs causes one more pass, so an event queued meanwhile is not left waiting for the next retry.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    const run = (async () => {
      let resync = false;
      do {
        this.flushAgain = false;
        if (await this.sendAll()) resync = true;
      } while (this.flushAgain && !this.stopped);
      // An event that may have reached the server before (lost response) was acknowledged: catch up with the cursor,
      // which carries its tombstone if another device deleted it meanwhile.
      if (resync && !this.stopped) void this.refresh();
    })().finally(() => {
      this.flushing = null;
      this.emit();
    });
    this.flushing = run;
    return run;
  }

  /** Runs a pass in `ms`, unless one is already set to run sooner. */
  private armTimer(ms: number) {
    if (this.stopped) return;
    const at = this.d.now() + ms;
    if (this.retryTimer !== null) {
      if (this.retryAt <= at) return;
      this.d.clearTimer(this.retryTimer);
    }
    this.retryAt = at;
    const handle: unknown = this.d.setTimer(() => {
      if (this.retryTimer !== handle) return;
      this.retryTimer = null;
      void this.flush();
    }, ms);
    this.retryTimer = handle;
  }

  private scheduleRetry() {
    if (this.queued.size === 0 && this.pendingDeletes.size === 0) return;
    const delay = this.retryDelay;
    // A pass already set to run sooner covers it (the backoff grows only when a retry is really scheduled).
    if (this.retryTimer !== null && this.retryAt <= this.d.now() + delay) return;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.armTimer(delay);
  }

  /** A pending delete waiting for its grace period runs when it comes due. */
  private scheduleDue() {
    let next = Infinity;
    for (const d of this.pendingDeletes.values()) next = Math.min(next, d.due);
    if (next === Infinity) return;
    this.armTimer(Math.max(1000, next - this.d.now()));
  }

  /**
   * Sends the pending deletes that are due. `sent`: one was applied (the cursor then carries its tombstone). `outcome`:
   * `stop` offline (nothing more is sent), `later` the server refused for now (5xx, 429: retried later, the queue is
   * still sent), `halt` the account (session ended).
   */
  private async sendDeletes(): Promise<{ outcome: 'ok' | 'stop' | 'later' | 'halt'; sent: boolean; tried: boolean }> {
    let sent = false;
    let tried = false;
    const due = [...this.pendingDeletes.values()].sort((a, b) => a.at - b.at);
    for (const d of due) {
      if (this.stopped) return { outcome: 'halt', sent, tried };
      const id = d.event_id;
      const current = this.pendingDeletes.get(id);
      if (!current || current.due > this.d.now()) continue;
      tried = true;
      try {
        await this.d.api.remove(id);
        await this.forgetDelete(id);
        sent = true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // Not on the server (yet): a create still in flight somewhere may land later, so a last DELETE follows once
          // the grace period has passed; after it, 404 settles it.
          const settle = current.at + DELETE_GRACE_MS;
          if (this.d.now() >= settle) await this.forgetDelete(id);
          else await this.markDeleted([id], settle);
          continue;
        }
        if (err instanceof NetworkError) {
          this.sendError = 'offline';
          return { outcome: 'stop', sent, tried };
        }
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return { outcome: 'halt', sent, tried };
        }
        if (err instanceof ApiError && err.status === 400) {
          // Never accepted (not an id the server takes): nothing to delete.
          await this.forgetDelete(id);
          continue;
        }
        if (err instanceof ApiError && err.status === 429) {
          this.retryDelay = Math.max(this.retryDelay, (err.retryAfterS ?? 5) * 1000);
        }
        return { outcome: 'later', sent, tried };
      }
    }
    return { outcome: 'ok', sent, tried };
  }

  /**
   * One pass: pending deletes first, then the queue. True when the cursor should be followed: a delete was applied, or
   * an event that may have reached the server before was acknowledged.
   */
  private async sendAll(): Promise<boolean> {
    const del = await this.sendDeletes();
    let resync = del.sent;
    if (del.outcome === 'stop') {
      this.scheduleRetry();
      return resync;
    }
    if (del.outcome === 'halt') return resync;
    if (this.settings?.paused || this.clearing) {
      if (del.outcome === 'later') this.scheduleRetry();
      else this.scheduleDue();
      return resync;
    }
    const pending = [...this.queued.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    let rejected = false;
    for (const item of pending) {
      if (this.stopped || this.clearing) return resync;
      // Deleted (here or through a tombstone) while this pass waited on an earlier item.
      if (!this.queued.has(item.event_id)) continue;
      if (await this.takenElsewhere(item.event_id)) {
        resync = true;
        continue;
      }
      const retry = this.attempted.has(item.event_id);
      const outcome = await this.sendOne(item);
      if (outcome === 'stop') {
        this.scheduleRetry();
        return resync;
      }
      if (outcome === 'halt') return resync;
      if (outcome === 'rejected') rejected = true;
      if (outcome === 'resync' || (outcome === 'ok' && retry)) resync = true;
    }
    if (pending.length || del.tried) this.sendError = rejected ? 'rejected' : null;
    if (del.outcome === 'later') {
      this.scheduleRetry();
      return resync;
    }
    this.retryDelay = RETRY_MIN_MS;
    this.scheduleDue();
    return resync;
  }

  /**
   * Another tab of this browser took the queued event out of the shared queue since this page read it (acknowledged,
   * deleted or cleared there): it is dropped here without being sent. True when it was.
   */
  private async takenElsewhere(id: string): Promise<boolean> {
    if (!this.stored.has(id)) return false;
    const state = await this.d.store.pendingState(this.d.userId, id).catch(() => null);
    if (!state || (state.queued && !state.deleted)) return false;
    this.queued.delete(id);
    this.attempted.delete(id);
    this.stored.delete(id);
    if (state.deleted) {
      this.deletedHere.add(id);
      this.texts.delete(id);
    }
    this.emit();
    return true;
  }

  /**
   * `ok`: sent; `resync`: sent, but the row is not taken from the acknowledgement (another tab changed it meanwhile),
   * so the cursor is followed; `rejected`: refused for good and dropped; `stop`: retry later; `halt`: wait for the user
   * or the account (paused, key problem, session ended).
   */
  private async sendOne(first: QueuedEvent): Promise<'ok' | 'resync' | 'rejected' | 'stop' | 'halt'> {
    let item = first;
    for (let attempt = 0; ; attempt++) {
      try {
        this.attempted.add(item.event_id);
        const res = await this.d.api.create({
          event_id: item.event_id,
          key_version: item.key_version,
          nonce: item.nonce,
          ciphertext: item.ciphertext,
          payload_size: item.payload_size,
          event_type: 'TEXT',
          mime_type: 'text/plain',
        });
        const e: RemoteClipboardEvent = {
          event_id: item.event_id,
          seq: res.seq,
          origin_device_id: this.d.deviceId,
          event_type: 'TEXT',
          mime_type: 'text/plain',
          key_version: item.key_version,
          nonce: item.nonce,
          ciphertext: item.ciphertext,
          payload_size: item.payload_size,
          created_at: res.created_at,
          expires_at: res.expires_at,
          deleted: false,
        };
        const id = e.event_id;
        if (this.tombstoned.has(id)) {
          // Deleted on another device meanwhile (its tombstone arrived): acknowledged, but not a row again.
          await this.dropQueued(id);
          this.texts.delete(id);
          this.emit();
          return 'ok';
        }
        if (this.deletedHere.has(id)) return this.ackDeleted(id);
        if (!this.queued.has(id)) {
          // A cursor pull already saw the event and acknowledged it (the server notifies before it answers the
          // create), or a reload took it out of this tab's queue: plain success.
          this.attempted.delete(id);
          return 'ok';
        }
        // The shared state decides, in one transaction (§2.9): another tab may have acknowledged, deleted or cleared
        // it, or pulled its tombstone, while the create was in flight.
        const state: AckState | null = await this.persistResult((s, g) => s.ackCreate(this.d.userId, e, g));
        if (state === 'deleted') return this.ackDeleted(id);
        if (state === 'taken' || state === 'gone') {
          // Not a row from this acknowledgement: never cached or shown from here. The cursor (or the shared cache)
          // says whether it is live.
          if (state === 'gone') this.tombstoned.add(id);
          this.queued.delete(id);
          this.attempted.delete(id);
          this.stored.delete(id);
          if (state === 'gone') this.texts.delete(id);
          this.emit();
          return 'resync';
        }
        // `live` (cached by `ackCreate` when the shared cursor has not passed it), or the store could not be used
        // (null): the row is shown.
        const text = this.texts.get(id);
        this.events.set(id, e);
        this.queued.delete(id);
        this.stored.delete(id);
        this.attempted.delete(id);
        if (text !== undefined) this.texts.set(id, text);
        this.emit();
        return 'ok';
      } catch (err) {
        if (err instanceof NetworkError) {
          this.sendError = 'offline';
          return 'stop';
        }
        if (!(err instanceof ApiError)) {
          this.sendError = 'error';
          return 'stop';
        }
        if (err.code === 'key_version_conflict' && attempt === 0 && this.d.onKeyConflict) {
          // The account rotated its key: pick the rotation up, re-encrypt under the newest version, send once more.
          await this.d.onKeyConflict().catch(() => undefined);
          const next = await this.reencrypt(item);
          if (next) {
            item = next;
            continue;
          }
        }
        if (err.code === 'key_version_conflict') {
          this.sendError = 'key';
          return 'halt';
        }
        if (err.code === 'clipboard_paused') {
          this.settings = { ...(this.settings ?? { retention_days: 7, sensitive_skip: true }), paused: true };
          void this.loadSettings();
          return 'halt';
        }
        if (err.status === 429) {
          this.sendError = 'rate_limited';
          this.retryDelay = Math.max(this.retryDelay, (err.retryAfterS ?? 5) * 1000);
          return 'stop';
        }
        if (err.status === 413 || err.status === 400) {
          // The server will never take this one (too large, malformed): drop it instead of retrying forever.
          await this.dropQueued(item.event_id);
          this.texts.delete(item.event_id);
          this.emit();
          return 'rejected';
        }
        if (err.status === 401 || err.status === 403) return 'halt';
        this.sendError = 'error';
        return 'stop';
      }
    }
  }

  /**
   * Deleted on this device (this tab or another) while the create was in flight: the create may have landed after the
   * DELETE, so the DELETE is sent once more (next pass).
   */
  private async ackDeleted(id: string): Promise<'ok'> {
    await this.markDeleted([id], this.d.now());
    this.flushAgain = true;
    this.emit();
    return 'ok';
  }

  /** Re-encrypts a queued event under the newest held key (same event_id), or null when there is nothing newer. */
  private async reencrypt(item: QueuedEvent): Promise<QueuedEvent | null> {
    const version = await this.d.keys.currentVersion();
    if (version <= item.key_version) return null;
    const text =
      this.texts.get(item.event_id) ??
      (await this.decrypt(item.event_id, item.key_version, item.nonce, item.ciphertext));
    if (text === null) return null;
    const key = await this.d.keys.loadSubkeys(version, 'clipboard');
    const next: QueuedEvent = {
      ...item,
      key_version: version,
      ...itemToWire(await encryptItem(key, item.event_id, version, text)),
    };
    this.queued.set(next.event_id, next);
    await this.persist((s, g) => s.enqueue(next, g));
    return next;
  }

  /**
   * Deletes one event on every device. A queued one leaves the queue at once and becomes a pending delete (it may have
   * reached the server, or reach it from a create in flight): its `DELETE` is sent now and retried with the queue until
   * confirmed, offline included (§2.9). A synced one is deleted on the server first (an error is thrown, the row stays).
   */
  async remove(id: string): Promise<void> {
    if (this.queued.has(id)) {
      await this.markDeleted([id], this.d.now());
      this.emit();
      await this.flush();
      void this.refresh();
      return;
    }
    try {
      await this.d.api.remove(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    this.deletedHere.add(id);
    this.events.delete(id);
    this.texts.delete(id);
    this.incoming.delete(id);
    await this.persist((s, g) => s.removeEvents(this.d.userId, [id], g));
    this.emit();
    void this.refresh();
  }

  /**
   * Clears the account's clipboard history on every device; tombstones arrive through the cursor. Queued captures are
   * dropped too and never sent after it (§2.9): every capture queued when Clear was pressed, in this tab or in the
   * browser's shared queue (another tab's), becomes a pending delete for the grace period, so a create still in flight
   * in another tab is deleted again; sends in flight in this tab finish before the clear request, and the server clear
   * tombstones those that reached it. A capture made after Clear was pressed is kept and sent after it.
   */
  async clear(): Promise<void> {
    this.clearing = true;
    const startedAt = this.d.now();
    const before = new Set(this.queued.keys());
    let dropped: string[];
    try {
      const shared = await this.d.store.queue(this.d.userId).catch(() => [] as QueuedEvent[]);
      for (const q of shared) {
        // Another tab's capture made before Clear was pressed (this tab's later captures are in its own queue).
        if (!this.queued.has(q.event_id) && !this.deletedHere.has(q.event_id) && q.queuedAt <= startedAt) {
          before.add(q.event_id);
        }
      }
      while (this.flushing) await this.flushing.catch(() => undefined);
      await this.d.api.clear();
      dropped = [...before];
    } catch (e) {
      this.clearing = false;
      void this.flush();
      throw e;
    }
    await this.markDeleted(dropped, this.d.now() + DELETE_GRACE_MS);
    this.clearing = false;
    const ids = [...this.events.keys()];
    this.events.clear();
    this.incoming.clear();
    for (const id of ids) this.texts.delete(id);
    await this.persist((s, g) => s.removeEvents(this.d.userId, ids, g));
    this.emit();
    void this.refresh();
    void this.flush();
  }

  /** The user copied this row: no longer "New", and the clipboard now holds its text (not captured again). */
  markCopied(id: string) {
    const text = this.texts.get(id);
    if (text) this.lastText = text;
    if (this.incoming.delete(id)) this.emit();
  }

  dismissSkipped(id: string) {
    this.skipped = this.skipped.filter((s) => s.id !== id);
    this.emit();
  }
}
