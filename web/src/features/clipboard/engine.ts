// Clipboard Sync runtime for one account on this device (docs/CLIPBOARD_PROTOCOL.md §2, PRD §7.4–§7.6). Loaded on
// demand, only for a signed-in account whose device is added and holds the key. Holds the decrypted timeline in
// memory, the encrypted cache and offline queue in IndexedDB, and follows the account's `seq` cursor.
import { decryptItemText, encryptItem, itemFromWire, itemToWire, type KeyStore } from '../../lib/crypto';
import { ApiError, NetworkError } from '../../lib/api/errors';
import {
  MAX_EVENTS,
  MAX_PAYLOAD_BYTES,
  type ClipboardApi,
  type ClipboardSettings,
  type RemoteClipboardEvent,
} from './api';
import { sensitiveKind, type SensitiveKind } from './sensitive';
import type { ClipboardStore, QueuedEvent } from './store';

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

export type CaptureResult =
  | { kind: 'synced' | 'queued'; id: string }
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
  private loadError: ClipboardSnapshot['loadError'] = null;
  private sendError: SendError | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private flushing: Promise<void> | null = null;
  private retryTimer: unknown = null;
  private retryDelay = RETRY_MIN_MS;
  private lastText: string | null = null;
  private lastSkipped: string | null = null;
  private stopped = false;
  private readonly generation: number;

  constructor(deps: EngineDeps) {
    this.d = {
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
    this.generation = this.d.store.generation();
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
   * Writes to the local store unless this engine was stopped or the store was wiped since it started (sign-out or the
   * account session ending while a request was in flight must not leave records behind). Storage errors are ignored:
   * the cache and queue are best effort, the server is the source of truth.
   */
  private async persist(fn: (s: ClipboardStore) => Promise<void>): Promise<void> {
    if (this.stopped || this.d.store.generation() !== this.generation) return;
    await fn(this.d.store).catch(() => undefined);
  }

  /** Reads the cache and the queue, then refreshes from the server, loads the settings and sends what is queued. */
  async start(): Promise<void> {
    try {
      const [cached, queue] = await Promise.all([
        this.d.store.events(this.d.userId),
        this.d.store.queue(this.d.userId),
      ]);
      for (const e of cached) if (!e.deleted && e.ciphertext && e.nonce) this.events.set(e.event_id, e);
      for (const q of queue) this.queued.set(q.event_id, q);
      await this.decryptMissing();
    } catch {
      /* the cache is a convenience: the server refresh below fills the timeline */
    }
    this.loaded = true;
    this.emit();
    await Promise.all([this.refresh(), this.loadSettings()]);
    void this.flush();
  }

  stop() {
    this.stopped = true;
    this.listeners.clear();
    if (this.retryTimer !== null) this.d.clearTimer(this.retryTimer);
    this.retryTimer = null;
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

  private async pull() {
    const { api, store, userId, deviceId } = this.d;
    try {
      let cursor = await store.cursor(userId).catch(() => null);
      // Tombstones are kept 7 days (docs/CLIPBOARD_PROTOCOL.md §2.5): a device that has not caught up for longer may
      // have missed deletions, so it reloads the live timeline instead of following its old cursor.
      const syncedAt = cursor === null ? null : await store.syncedAt(userId).catch(() => null);
      if (cursor !== null && (syncedAt === null || this.d.now() - syncedAt > STALE_CURSOR_MS)) cursor = null;
      if (cursor === null) {
        const h = await api.history();
        const live = h.events.filter((e) => !e.deleted && e.ciphertext && e.nonce);
        await this.persist((s) => s.replace(userId, live, h.cursor));
        this.events = new Map(live.map((e) => [e.event_id, e]));
        for (const id of this.queued.keys()) if (this.events.has(id)) await this.acked(id);
        cursor = h.cursor;
      }
      for (let page = 0; page < 50; page++) {
        const { events, next_cursor } = await api.events(cursor);
        if (!events.length) break;
        const put: RemoteClipboardEvent[] = [];
        const remove: string[] = [];
        for (const e of events) {
          if (e.deleted || !e.ciphertext || !e.nonce) {
            remove.push(e.event_id);
            this.events.delete(e.event_id);
            this.texts.delete(e.event_id);
            this.incoming.delete(e.event_id);
            continue;
          }
          put.push(e);
          const fresh = !this.events.has(e.event_id) && !this.queued.has(e.event_id);
          this.events.set(e.event_id, e);
          if (fresh && this.loaded && e.origin_device_id !== deviceId) this.incoming.add(e.event_id);
          if (this.queued.has(e.event_id)) await this.acked(e.event_id);
        }
        const next = Math.max(cursor, next_cursor, ...events.map((e) => e.seq));
        await this.persist((s) => s.apply(userId, { put, remove, cursor: next }));
        if (next <= cursor) break;
        cursor = next;
      }
      await this.decryptMissing();
      this.loadError = null;
    } catch (e) {
      this.loadError = e instanceof NetworkError ? 'offline' : 'error';
    }
  }

  private async acked(id: string) {
    const text = this.texts.get(id);
    this.queued.delete(id);
    if (text !== undefined) this.texts.set(id, text);
    await this.persist((s) => s.dequeue(this.d.userId, id));
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
    const id = this.d.uuid();
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
    await this.persist((s) => s.enqueue(item));
    this.emit();
    await this.flush();
    return { kind: this.queued.has(id) ? 'queued' : 'synced', id };
  }

  /** Sends queued events in capture order. Idempotent by `event_id`, so a retry never duplicates an event. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.sendAll().finally(() => {
      this.flushing = null;
      this.emit();
    });
    this.flushing = run;
    return run;
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer !== null || this.queued.size === 0) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.retryTimer = this.d.setTimer(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  private async sendAll() {
    if (this.settings?.paused) return;
    const pending = [...this.queued.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    let rejected = false;
    for (const item of pending) {
      if (this.stopped) return;
      const outcome = await this.sendOne(item);
      if (outcome === 'stop') {
        this.scheduleRetry();
        return;
      }
      if (outcome === 'halt') return;
      if (outcome === 'rejected') rejected = true;
    }
    if (pending.length) this.sendError = rejected ? 'rejected' : null;
    this.retryDelay = RETRY_MIN_MS;
  }

  /**
   * `ok`: sent; `rejected`: refused for good and dropped; `stop`: retry later; `halt`: wait for the user or the account
   * (paused, key problem, session ended).
   */
  private async sendOne(first: QueuedEvent): Promise<'ok' | 'rejected' | 'stop' | 'halt'> {
    let item = first;
    for (let attempt = 0; ; attempt++) {
      try {
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
        this.events.set(e.event_id, e);
        await this.persist((s) => s.apply(this.d.userId, { put: [e] }));
        await this.acked(item.event_id);
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
          this.queued.delete(item.event_id);
          this.texts.delete(item.event_id);
          await this.persist((s) => s.dequeue(this.d.userId, item.event_id));
          this.emit();
          return 'rejected';
        }
        if (err.status === 401 || err.status === 403) return 'halt';
        this.sendError = 'error';
        return 'stop';
      }
    }
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
    await this.persist((s) => s.enqueue(next));
    return next;
  }

  /** Deletes one event on every device (a queued one is simply dropped here and deleted in case it reached the server). */
  async remove(id: string): Promise<void> {
    const wasQueued = this.queued.has(id);
    if (wasQueued) {
      this.queued.delete(id);
      await this.persist((s) => s.dequeue(this.d.userId, id));
    }
    try {
      await this.d.api.remove(id);
    } catch (e) {
      const gone = e instanceof ApiError && e.status === 404;
      if (!gone && !wasQueued) throw e;
    }
    this.events.delete(id);
    this.texts.delete(id);
    this.incoming.delete(id);
    await this.persist((s) => s.apply(this.d.userId, { remove: [id] }));
    this.emit();
    void this.refresh();
  }

  /** Clears the account's clipboard history on every device; tombstones arrive through the cursor. */
  async clear(): Promise<void> {
    await this.d.api.clear();
    const ids = [...this.events.keys()];
    this.events.clear();
    this.incoming.clear();
    for (const id of ids) this.texts.delete(id);
    await this.persist((s) => s.apply(this.d.userId, { remove: ids }));
    this.emit();
    void this.refresh();
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
