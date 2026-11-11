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
  private retryTimer: unknown = null;
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
  private async persist(fn: (s: ClipboardStore, gen: string) => Promise<boolean>): Promise<void> {
    if (this.stopped || this.wiped) return;
    const gen = await this.generation;
    if (gen === null || this.stopped) return;
    const wrote = await fn(this.d.store, gen).catch(() => true);
    if (!wrote) this.wiped = true;
  }

  /** Reads the cache and the queue, then refreshes from the server, loads the settings and sends what is queued. */
  async start(): Promise<void> {
    try {
      const [cached, queue] = await Promise.all([
        this.d.store.events(this.d.userId),
        this.d.store.queue(this.d.userId),
      ]);
      for (const e of cached) if (!e.deleted && e.ciphertext && e.nonce) this.events.set(e.event_id, e);
      for (const q of queue) {
        this.queued.set(q.event_id, q);
        this.attempted.add(q.event_id);
      }
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
        await this.persist((s, g) => s.replace(userId, live, h.cursor, g));
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
            this.incoming.delete(e.event_id);
            this.tombstoned.add(e.event_id);
            // Deleted on another device while still queued here (its create reached the server but the response was
            // lost): drop it, so the retry cannot bring it back.
            if (this.queued.has(e.event_id)) await this.dropQueued(e.event_id);
            this.texts.delete(e.event_id);
            continue;
          }
          put.push(e);
          const fresh = !this.events.has(e.event_id) && !this.queued.has(e.event_id);
          this.events.set(e.event_id, e);
          if (fresh && this.loaded && e.origin_device_id !== deviceId) this.incoming.add(e.event_id);
          if (this.queued.has(e.event_id)) await this.acked(e.event_id);
        }
        const next = Math.max(cursor, next_cursor, ...events.map((e) => e.seq));
        await this.persist((s, g) => s.apply(userId, { put, remove, cursor: next }, g));
        if (next <= cursor) break;
        cursor = next;
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
    if (text !== undefined) this.texts.set(id, text);
    await this.persist((s, g) => s.dequeue(this.d.userId, id, g));
  }

  /** Drops a queued event locally (never sent again). */
  private async dropQueued(id: string) {
    this.queued.delete(id);
    this.attempted.delete(id);
    await this.persist((s, g) => s.dequeue(this.d.userId, id, g));
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
    await this.persist((s, g) => s.enqueue(item, g));
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

  private scheduleRetry() {
    if (this.stopped || this.retryTimer !== null || this.queued.size === 0) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.retryTimer = this.d.setTimer(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  /** One pass over the queue. True when an event that may have reached the server before was acknowledged. */
  private async sendAll(): Promise<boolean> {
    if (this.settings?.paused) return false;
    const pending = [...this.queued.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    let rejected = false;
    let resync = false;
    for (const item of pending) {
      if (this.stopped) return resync;
      // Deleted (here or through a tombstone) while this pass waited on an earlier item.
      if (!this.queued.has(item.event_id)) continue;
      const retry = this.attempted.has(item.event_id);
      const outcome = await this.sendOne(item);
      if (outcome === 'stop') {
        this.scheduleRetry();
        return resync;
      }
      if (outcome === 'halt') return resync;
      if (outcome === 'rejected') rejected = true;
      if (outcome === 'ok' && retry) resync = true;
    }
    if (pending.length) this.sendError = rejected ? 'rejected' : null;
    this.retryDelay = RETRY_MIN_MS;
    return resync;
  }

  /**
   * `ok`: sent; `rejected`: refused for good and dropped; `stop`: retry later; `halt`: wait for the user or the account
   * (paused, key problem, session ended).
   */
  private async sendOne(first: QueuedEvent): Promise<'ok' | 'rejected' | 'stop' | 'halt'> {
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
        if (this.tombstoned.has(e.event_id) || !this.queued.has(e.event_id)) {
          // Deleted meanwhile (a tombstone arrived, or the user deleted it here): acknowledged, but not a row again.
          // A local delete may have reached the server before this create did, so it is sent once more.
          if (!this.tombstoned.has(e.event_id)) void this.d.api.remove(e.event_id).catch(() => undefined);
          await this.dropQueued(e.event_id);
          this.texts.delete(e.event_id);
          this.emit();
          return 'ok';
        }
        this.events.set(e.event_id, e);
        await this.persist((s, g) => s.apply(this.d.userId, { put: [e] }, g));
        await this.acked(item.event_id);
        this.attempted.delete(item.event_id);
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

  /** Deletes one event on every device (a queued one is simply dropped here and deleted in case it reached the server). */
  async remove(id: string): Promise<void> {
    const wasQueued = this.queued.has(id);
    if (wasQueued) await this.dropQueued(id);
    try {
      await this.d.api.remove(id);
    } catch (e) {
      const gone = e instanceof ApiError && e.status === 404;
      if (!gone && !wasQueued) throw e;
    }
    this.events.delete(id);
    this.texts.delete(id);
    this.incoming.delete(id);
    await this.persist((s, g) => s.apply(this.d.userId, { remove: [id] }, g));
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
    await this.persist((s, g) => s.apply(this.d.userId, { remove: ids }, g));
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
