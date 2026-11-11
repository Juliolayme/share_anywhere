// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  b64uDecode,
  b64uEncode,
  decryptItemText,
  encryptItem,
  generateAdk,
  itemFromWire,
  openKeyStore,
  type KeyStore,
} from '../../lib/crypto';
import { ApiError, NetworkError } from '../../lib/api/errors';
import type { ClipboardApi, ClipboardEventRequest, ClipboardSettings, RemoteClipboardEvent } from './api';
import { ClipboardEngine, type EngineDeps } from './engine';
import { openClipboardStore, type ClipboardStore } from './store';

const USER = 'u1';

/**
 * In-memory stand-in for the clipboard endpoints (docs/CLIPBOARD_PROTOCOL.md §2): per-account seq assigned in commit
 * order, idempotent on event_id, tombstones with a new seq, current key version enforced, pause, 256 KB limit.
 */
function fakeServer() {
  let seq = 0;
  let keyVersion = 1;
  let offline = false;
  let failNext: ApiError | null = null;
  const rows = new Map<string, RemoteClipboardEvent>();
  const posts: ClipboardEventRequest[] = [];
  const cursorsSent: number[] = [];
  let settings: ClipboardSettings = { paused: false, retention_days: 7, sensitive_skip: true };
  let origin = 'dev-a';
  const guard = () => {
    if (offline) throw new NetworkError();
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
  };
  const tombstone = (id: string) => {
    const r = rows.get(id);
    if (!r || r.deleted) return;
    seq++;
    rows.set(id, { ...r, seq, deleted: true, nonce: null, ciphertext: null });
  };
  const api: ClipboardApi = {
    history: async () => {
      guard();
      const events = [...rows.values()].filter((r) => !r.deleted).sort((a, b) => b.seq - a.seq);
      return { events, cursor: seq };
    },
    events: async (cursor: number, limit = 100) => {
      guard();
      cursorsSent.push(cursor);
      const events = [...rows.values()]
        .filter((r) => r.seq > cursor)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      return { events, next_cursor: events.length ? (events[events.length - 1]?.seq ?? cursor) : cursor };
    },
    create: async (req: ClipboardEventRequest) => {
      guard();
      posts.push(req);
      if (settings.paused) throw new ApiError(409, 'clipboard_paused', 'paused');
      if (req.payload_size > 262144) throw new ApiError(413, 'payload_too_large', 'too large');
      const existing = rows.get(req.event_id);
      if (existing) return { seq: existing.seq, created_at: existing.created_at, expires_at: existing.expires_at };
      if (req.key_version !== keyVersion) throw new ApiError(409, 'key_version_conflict', 'conflict');
      seq++;
      const now = Date.now();
      const row: RemoteClipboardEvent = {
        event_id: req.event_id,
        seq,
        origin_device_id: origin,
        event_type: 'TEXT',
        mime_type: 'text/plain',
        key_version: req.key_version,
        nonce: req.nonce,
        ciphertext: req.ciphertext,
        payload_size: req.payload_size,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 7 * 86400_000).toISOString(),
        deleted: false,
      };
      rows.set(req.event_id, row);
      return { seq, created_at: row.created_at, expires_at: row.expires_at };
    },
    remove: async (id: string) => {
      guard();
      if (!rows.has(id)) throw new ApiError(404, 'not_found', 'unknown');
      tombstone(id);
      return undefined;
    },
    clear: async () => {
      guard();
      for (const id of [...rows.keys()]) tombstone(id);
      return undefined;
    },
    settings: async () => {
      guard();
      return settings;
    },
    saveSettings: async (s: ClipboardSettings) => {
      guard();
      settings = { ...s };
      return settings;
    },
  };
  return {
    api,
    rows,
    posts,
    cursorsSent,
    as: (d: string) => (origin = d),
    setOffline: (v: boolean) => (offline = v),
    setKeyVersion: (v: number) => (keyVersion = v),
    setPaused: (v: boolean) => (settings = { ...settings, paused: v }),
    failOnce: (e: ApiError) => (failNext = e),
    /** A malicious server swapping two rows' ciphertexts (the AAD binds each ciphertext to its event_id). */
    swap: (a: string, b: string) => {
      const ra = rows.get(a);
      const rb = rows.get(b);
      if (!ra || !rb) return;
      rows.set(a, { ...ra, nonce: rb.nonce, ciphertext: rb.ciphertext });
      rows.set(b, { ...rb, nonce: ra.nonce, ciphertext: ra.ciphertext });
    },
    relabel: (id: string, keyVersion: number) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, key_version: keyVersion });
    },
  };
}

interface Device {
  id: string;
  keys: KeyStore;
  store: ClipboardStore;
  factory: IDBFactory;
}

async function device(id: string, adks: { version: number; raw: Uint8Array }[]): Promise<Device> {
  const factory = new IDBFactory();
  const keys = await openKeyStore({ factory });
  for (const a of adks) await keys.saveAdk(a.version, a.raw);
  return { id, keys, store: openClipboardStore(factory), factory };
}

function engine(server: ReturnType<typeof fakeServer>, d: Device, over: Partial<EngineDeps> = {}) {
  const timers: (() => void)[] = [];
  const e = new ClipboardEngine({
    api: {
      ...server.api,
      create: (req) => {
        server.as(d.id);
        return server.api.create(req);
      },
    },
    keys: d.keys,
    store: d.store,
    userId: USER,
    deviceId: d.id,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
    ...over,
  });
  return { e, timers };
}

const adk1 = generateAdk(1);
const adk2 = generateAdk(2);
const texts = (e: ClipboardEngine) => e.snapshot().items.map((i) => i.text);

describe('clipboard item encryption (clipboard-v1 subkey, docs/CLIPBOARD_PROTOCOL.md §1.3)', () => {
  it('round-trips UTF-8 text and binds the ciphertext to event_id and key_version (AAD)', async () => {
    const d = await device('dev-a', [adk1]);
    const key = await d.keys.loadSubkeys(1, 'clipboard');
    const id = '0d4f1c2e-7a6b-4c1d-9e8f-001122334455';
    const text = 'Order #A-5531 ships Thursday — tracking VN829104455 · Tiếng Việt 🚚';
    const item = await encryptItem(key, id, 1, text);
    expect(await decryptItemText(key, id, 1, item)).toBe(text);
    // Another event_id or a relabelled key_version fails authentication (no detail beyond one error).
    const otherId = `${id.slice(0, -1)}6`;
    await expect(decryptItemText(key, otherId, 1, item)).rejects.toMatchObject({
      code: 'decrypt_failed',
    });
    await d.keys.saveAdk(2, adk2.raw);
    await expect(decryptItemText(key, id, 2, item)).rejects.toMatchObject({ code: 'decrypt_failed' });
    // One flipped ciphertext byte fails too.
    const flipped = Uint8Array.from(item.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    await expect(decryptItemText(key, id, 1, { ...item, ciphertext: flipped })).rejects.toMatchObject({
      code: 'decrypt_failed',
    });
    // The history subkey of the same ADK cannot open a clipboard item.
    const history = await d.keys.loadSubkeys(1, 'history');
    await expect(decryptItemText(history, id, 1, item)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('draws a fresh 12-byte nonce for each of 10,000 items', async () => {
    const d = await device('dev-a', [adk1]);
    const key = await d.keys.loadSubkeys(1, 'clipboard');
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const item = await encryptItem(key, `evt-${i}`, 1, 'same text');
      expect(item.nonce).toHaveLength(12);
      seen.add(b64uEncode(item.nonce));
    }
    expect(seen.size).toBe(10_000);
  }, 60_000);
});

describe('ClipboardEngine', () => {
  it('captures on one device, encrypts before sending, and another device decrypts it by cursor', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const b = await device('dev-b', [adk1]);
    const ea = engine(server, a).e;
    const eb = engine(server, b).e;
    await ea.start();
    await eb.start();
    const r = await ea.capture('meeting at 10:30 in room 4', 'manual');
    expect(r.kind).toBe('synced');
    // The server never sees the plaintext.
    const post = server.posts[0];
    expect(post).toBeDefined();
    expect(JSON.stringify(post)).not.toContain('meeting');
    expect(post?.key_version).toBe(1);
    expect(post?.payload_size).toBe(new TextEncoder().encode('meeting at 10:30 in room 4').length);
    expect(b64uDecode(post?.nonce ?? '')).toHaveLength(12);
    // B follows its cursor (as on a CLIPBOARD_EVENT_CREATED notification) and shows it as new.
    await eb.refresh();
    const item = eb.snapshot().items[0];
    expect(item?.text).toBe('meeting at 10:30 in room 4');
    expect(item?.origin).toBe('dev-a');
    expect(item?.incoming).toBe(true);
    eb.markCopied(item?.id ?? '');
    expect(eb.snapshot().items[0]?.incoming).toBe(false);
    // The copied text is now on B's clipboard: an automatic capture of it is not sent back.
    expect((await eb.capture('meeting at 10:30 in room 4', 'auto')).kind).toBe('duplicate');
    expect(server.posts).toHaveLength(1);
  });

  it('loads the timeline once with GET /history, then only follows the cursor (persisted per account)', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const ea = engine(server, a).e;
    await ea.start();
    await ea.capture('first', 'manual');
    await ea.capture('second', 'manual');
    const b = await device('dev-b', [adk1]);
    const historySpy = vi.spyOn(server.api, 'history');
    const eb1 = engine(server, b).e;
    await eb1.start();
    expect(texts(eb1)).toEqual(['second', 'first']);
    expect(await b.store.cursor(USER)).toBe(2);
    eb1.stop();
    // A reload: the cached timeline shows before any request, and the cursor (not /history) is followed.
    server.setOffline(true);
    const eb2 = engine(server, b).e;
    await eb2.start();
    expect(texts(eb2)).toEqual(['second', 'first']);
    expect(eb2.snapshot().loadError).toBe('offline');
    server.setOffline(false);
    await ea.capture('third', 'manual');
    await eb2.refresh();
    expect(texts(eb2)).toEqual(['third', 'second', 'first']);
    expect(historySpy).toHaveBeenCalledTimes(1);
    // The cursor sent is what this device applied: never backwards.
    expect(server.cursorsSent.at(-1)).toBe(3);
  });

  it('applies deletions and "clear history" from any device through the cursor', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const b = await device('dev-b', [adk1]);
    const ea = engine(server, a).e;
    const eb = engine(server, b).e;
    await ea.start();
    await eb.start();
    await ea.capture('one', 'manual');
    await ea.capture('two', 'manual');
    await eb.refresh();
    expect(texts(eb)).toEqual(['two', 'one']);
    await eb.remove(eb.snapshot().items[0]?.id ?? '');
    await ea.refresh();
    expect(texts(ea)).toEqual(['one']);
    await ea.clear();
    await eb.refresh();
    expect(texts(eb)).toEqual([]);
    expect(await b.store.events(USER)).toEqual([]);
  });

  it('a row the server moved or relabelled does not decrypt: it shows as locked, never as wrong text', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const ea = engine(server, a).e;
    await ea.start();
    await ea.capture('alpha text', 'manual');
    await ea.capture('beta text', 'manual');
    const [beta, alpha] = [...server.rows.keys()].reverse();
    server.swap(alpha ?? '', beta ?? '');
    const b = await device('dev-b', [adk1, adk2]);
    const eb = engine(server, b).e;
    await eb.start();
    expect(texts(eb)).toEqual([null, null]);
    expect(eb.snapshot().unreadable).toBe(2);
    // Relabelling a version: the AAD includes key_version, so even holding v2 does not help.
    const c = await device('dev-c', [adk1, adk2]);
    const server2 = fakeServer();
    const ec = engine(server2, a).e;
    await ec.start();
    await ec.capture('gamma text', 'manual');
    server2.relabel([...server2.rows.keys()][0] ?? '', 2);
    const ed = engine(server2, c).e;
    await ed.start();
    expect(texts(ed)).toEqual([null]);
  });

  it('a row under a key version this device lacks is locked until the key arrives', async () => {
    const server = fakeServer();
    server.setKeyVersion(2);
    const a = await device('dev-a', [adk1, adk2]);
    const b = await device('dev-b', [adk1]);
    const ea = engine(server, a).e;
    const eb = engine(server, b).e;
    await ea.start();
    await eb.start();
    await ea.capture('after rotation', 'manual');
    await eb.refresh();
    expect(texts(eb)).toEqual([null]);
    await b.keys.saveAdk(2, adk2.raw);
    await eb.keysChanged();
    expect(texts(eb)).toEqual(['after rotation']);
  });

  it('offline: captures are encrypted and queued in IndexedDB, survive a reload, and are sent once', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e: e1 } = engine(server, a);
    await e1.start();
    server.setOffline(true);
    const r = await e1.capture('written on the train', 'manual');
    expect(r.kind).toBe('queued');
    expect(e1.snapshot().queued).toBe(1);
    expect(e1.snapshot().sendError).toBe('offline');
    expect(e1.snapshot().items[0]).toMatchObject({ text: 'written on the train', pending: true, seq: null });
    const queued = await a.store.queue(USER);
    expect(queued).toHaveLength(1);
    // Only ciphertext is stored.
    expect(JSON.stringify(queued)).not.toContain('train');
    e1.stop();

    // A reload while still offline keeps the queue; back online, it is sent exactly once.
    const { e: e2, timers } = engine(server, a);
    await e2.start();
    expect(e2.snapshot().items[0]?.text).toBe('written on the train');
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    server.setOffline(false);
    timers.shift()?.();
    await e2.flush();
    expect(server.rows.size).toBe(1);
    expect(e2.snapshot().queued).toBe(0);
    expect(await a.store.queue(USER)).toEqual([]);
    expect(e2.snapshot().items[0]).toMatchObject({ pending: false, seq: 1 });
    // A retry of an event the server already stored (lost response) is idempotent by event_id.
    const again = server.posts[server.posts.length - 1];
    if (again) await server.api.create(again);
    expect(server.rows.size).toBe(1);
  });

  it('409 key_version_conflict: runs a key check, re-encrypts with the new version, retries once', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    server.setKeyVersion(2);
    const onKeyConflict = vi.fn(async () => {
      await a.keys.saveAdk(2, adk2.raw);
    });
    const { e } = engine(server, a, { onKeyConflict });
    await e.start();
    const r = await e.capture('rotated meanwhile', 'manual');
    expect(r.kind).toBe('synced');
    expect(onKeyConflict).toHaveBeenCalledTimes(1);
    expect(server.posts.map((p) => p.key_version)).toEqual([1, 2]);
    expect(server.posts[0]?.event_id).toBe(server.posts[1]?.event_id);
    const row = [...server.rows.values()][0];
    const key = await a.keys.loadSubkeys(2, 'clipboard');
    expect(
      await decryptItemText(
        key,
        row?.event_id ?? '',
        2,
        itemFromWire({ nonce: row?.nonce ?? '', ciphertext: row?.ciphertext ?? '' }),
      ),
    ).toBe('rotated meanwhile');
  });

  it('a conflict that persists after the key check stays queued with the key error', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    server.setKeyVersion(3);
    const { e } = engine(server, a, { onKeyConflict: async () => undefined });
    await e.start();
    expect((await e.capture('cannot send', 'manual')).kind).toBe('queued');
    expect(e.snapshot().sendError).toBe('key');
    expect(server.posts).toHaveLength(1);
  });

  it('409 clipboard_paused shows the paused state and keeps the item queued until sync resumes', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    server.setPaused(true);
    expect((await e.capture('held back', 'manual')).kind).toBe('queued');
    await vi.waitFor(() => expect(e.snapshot().settings?.paused).toBe(true));
    // While paused nothing more is read or sent.
    expect((await e.capture('another', 'manual')).kind).toBe('paused');
    await e.saveSettings({ paused: false, retention_days: 7, sensitive_skip: true });
    await vi.waitFor(() => expect(e.snapshot().queued).toBe(0));
    expect([...server.rows.values()]).toHaveLength(1);
  });

  it('413 drops the item instead of retrying it forever; oversize text is refused before encryption', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    expect((await e.capture('x'.repeat(262_145), 'manual')).kind).toBe('too_large');
    expect(server.posts).toHaveLength(0);
    server.failOnce(new ApiError(413, 'payload_too_large', 'too large'));
    await e.capture('looks fine here', 'manual');
    expect(e.snapshot().queued).toBe(0);
    expect(e.snapshot().items).toHaveLength(0);
    expect(e.snapshot().sendError).toBe('rejected');
  });

  it('sensitive text: automatic captures are skipped and noted; manual Sync asks, and "Sync anyway" sends', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    expect(await e.capture('482913', 'auto')).toEqual({ kind: 'sensitive', sensitive: 'otp' });
    expect(e.snapshot().skipped).toHaveLength(1);
    // The same text on the next focus is not noted again.
    expect((await e.capture('482913', 'auto')).kind).toBe('duplicate');
    expect(e.snapshot().skipped).toHaveLength(1);
    expect(await e.capture('482913', 'manual')).toEqual({ kind: 'sensitive', sensitive: 'otp' });
    expect(server.posts).toHaveLength(0);
    expect((await e.capture('482913', 'manual', true)).kind).toBe('synced');
    expect(server.posts).toHaveLength(1);
    // With sensitive handling off (account setting), nothing is skipped.
    await e.saveSettings({ paused: false, retention_days: 7, sensitive_skip: false });
    expect((await e.capture('771204', 'copy')).kind).toBe('synced');
  });

  it('identical consecutive text is not synced twice; empty text is ignored', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    expect((await e.capture('same words', 'manual')).kind).toBe('synced');
    expect((await e.capture('same words', 'manual')).kind).toBe('duplicate');
    expect((await e.capture('same words', 'auto')).kind).toBe('duplicate');
    expect((await e.capture('   ', 'manual')).kind).toBe('empty');
    expect((await e.capture('other words', 'copy')).kind).toBe('synced');
    expect(server.posts).toHaveLength(2);
  });

  it('settings from CLIPBOARD_SETTINGS_UPDATED resume sending the queue', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    server.setPaused(true);
    await e.capture('queued while paused', 'manual');
    await vi.waitFor(() => expect(e.snapshot().settings?.paused).toBe(true));
    server.setPaused(false);
    e.applySettings({ paused: false, retention_days: 3, sensitive_skip: true });
    await vi.waitFor(() => expect(e.snapshot().queued).toBe(0));
    expect(e.snapshot().settings?.retention_days).toBe(3);
  });

  it('deleting a queued item drops it locally and never sends it', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    server.setOffline(true);
    await e.capture('typo, delete me', 'manual');
    const id = e.snapshot().items[0]?.id ?? '';
    await e.remove(id);
    expect(e.snapshot().items).toEqual([]);
    expect(await a.store.queue(USER)).toEqual([]);
    server.setOffline(false);
    await e.flush();
    expect(server.rows.size).toBe(0);
  });

  it('after a wipe (sign-out, session end) a runtime still running writes nothing more to the store', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    await e.capture('kept before', 'manual');
    expect(await a.store.events(USER)).toHaveLength(1);
    await a.store.wipe();
    server.setOffline(true);
    await e.capture('typed during sign-out', 'manual');
    await e.refresh();
    expect(await a.store.events(USER)).toEqual([]);
    expect(await a.store.queue(USER)).toEqual([]);
    expect(await a.store.cursor(USER)).toBeNull();
  });

  it('hides expired events (retention) and keeps at most 100 live ones', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const key = await a.keys.loadSubkeys(1, 'clipboard');
    const now = Date.now();
    const rows: RemoteClipboardEvent[] = [];
    for (let i = 1; i <= 102; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const item = await encryptItem(key, id, 1, `item ${i}`);
      rows.push({
        event_id: id,
        seq: i,
        origin_device_id: 'dev-b',
        event_type: 'TEXT',
        mime_type: 'text/plain',
        key_version: 1,
        nonce: b64uEncode(item.nonce),
        ciphertext: b64uEncode(item.ciphertext),
        payload_size: 6,
        created_at: new Date(now - (200 - i) * 1000).toISOString(),
        expires_at: new Date(i === 102 ? now - 1 : now + 86400_000).toISOString(),
        deleted: false,
      });
    }
    await a.store.replace(USER, rows, 102);
    server.setOffline(true);
    const { e } = engine(server, a);
    await e.start();
    const shown = e.snapshot().items;
    expect(shown).toHaveLength(100);
    expect(shown[0]?.text).toBe('item 101');
    expect(shown.some((i) => i.text === 'item 102')).toBe(false);
  });
});
