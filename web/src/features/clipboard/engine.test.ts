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
import { ClipboardEngine, DELETE_GRACE_MS, type EngineDeps } from './engine';
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
    await a.store.replace(USER, rows, 102, await a.store.generation());
    server.setOffline(true);
    const { e } = engine(server, a);
    await e.start();
    const shown = e.snapshot().items;
    expect(shown).toHaveLength(100);
    expect(shown[0]?.text).toBe('item 101');
    expect(shown.some((i) => i.text === 'item 102')).toBe(false);
  });

  it('event ids are lowercase canonical UUID text, on the wire and in the AAD (§1.3)', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    await e.capture('default id', 'manual');
    // An id source that answers in upper case is normalized before anything is encrypted or queued.
    const upper = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';
    const { e: e2 } = engine(server, a, { uuid: () => upper });
    await e2.start();
    await e2.capture('upper-case source', 'manual');
    const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(server.posts.map((p) => p.event_id).every((id) => canonical.test(id))).toBe(true);
    expect(server.posts[1]?.event_id).toBe(upper.toLowerCase());
    const row = server.rows.get(upper.toLowerCase());
    const key = await a.keys.loadSubkeys(1, 'clipboard');
    const wire = itemFromWire({ nonce: row?.nonce ?? '', ciphertext: row?.ciphertext ?? '' });
    expect(await decryptItemText(key, upper.toLowerCase(), 1, wire)).toBe('upper-case source');
    await expect(decryptItemText(key, upper, 1, wire)).rejects.toMatchObject({ code: 'decrypt_failed' });
    // v1: the ciphertext is exactly payload_size + 16 bytes (the server checks this).
    for (const p of server.posts) expect(b64uDecode(p.ciphertext)).toHaveLength(p.payload_size + 16);
    // An id source that does not produce a UUID is refused instead of sending a form the server rejects.
    const { e: e3 } = engine(server, a, { uuid: () => 'evt-1' });
    await e3.start();
    await expect(e3.capture('bad id', 'manual')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(server.posts).toHaveLength(2);
  });

  it('QA: create reaches the server but the response is lost, another device deletes it: no ghost row', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const b = await device('dev-b', [adk1]);
    let loseNext = true;
    const { e: ea, timers } = engine(server, a, {
      api: {
        ...server.api,
        create: async (req) => {
          server.as('dev-a');
          const res = await server.api.create(req);
          if (loseNext) {
            loseNext = false;
            throw new NetworkError();
          }
          return res;
        },
      },
    });
    const { e: eb } = engine(server, b);
    await ea.start();
    await eb.start();
    // The create is stored, but A never hears back: the event stays queued on A.
    expect((await ea.capture('delete me elsewhere', 'manual')).kind).toBe('queued');
    expect(server.rows.size).toBe(1);
    const id = server.posts[0]?.event_id ?? '';
    // B sees it and deletes it.
    await eb.refresh();
    expect(texts(eb)).toEqual(['delete me elsewhere']);
    await eb.remove(id);
    expect(server.rows.get(id)?.deleted).toBe(true);
    // A pulls the tombstone while the event is still queued: it leaves the queue (memory and IndexedDB).
    await ea.refresh();
    expect(ea.snapshot().items).toEqual([]);
    expect(ea.snapshot().queued).toBe(0);
    expect(await a.store.queue(USER)).toEqual([]);
    // The retry timer fires: nothing is sent again and the row does not come back, here or after a reload.
    const posts = server.posts.length;
    timers.shift()?.();
    await ea.flush();
    expect(server.posts).toHaveLength(posts);
    expect(ea.snapshot().items).toEqual([]);
    ea.stop();
    const { e: again } = engine(server, a);
    await again.start();
    expect(again.snapshot().items).toEqual([]);
    expect(server.rows.get(id)?.deleted).toBe(true);
  });

  it('QA: a retry acknowledged after the delete (tombstone not pulled yet) does not leave the row behind', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const b = await device('dev-b', [adk1]);
    let loseNext = true;
    const { e: ea, timers } = engine(server, a, {
      api: {
        ...server.api,
        create: async (req) => {
          server.as('dev-a');
          const res = await server.api.create(req);
          if (loseNext) {
            loseNext = false;
            throw new NetworkError();
          }
          return res;
        },
      },
    });
    const { e: eb } = engine(server, b);
    await ea.start();
    await eb.start();
    await ea.capture('gone before the retry', 'manual');
    const id = server.posts[0]?.event_id ?? '';
    await eb.refresh();
    await eb.remove(id);
    // The retry runs first: the server answers the idempotent repeat (201, tombstone seq) without restoring it, and
    // A catches up with its cursor right after, which removes the row it briefly acknowledged.
    timers.shift()?.();
    await ea.flush();
    await vi.waitFor(() => expect(ea.snapshot().syncing).toBe(false));
    expect(ea.snapshot().items).toEqual([]);
    expect(await a.store.events(USER)).toEqual([]);
    expect(await a.store.queue(USER)).toEqual([]);
  });

  it("a wipe in another tab stops this tab's running engine from writing anything back", async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    await e.capture('kept before', 'manual');
    expect(await a.store.events(USER)).toHaveLength(1);
    // Another tab of the same browser (its own connection to the same database) signs out and wipes.
    const otherTab = openClipboardStore(a.factory);
    await otherTab.wipe();
    // This tab's engine keeps running: a capture, a refresh with new events, and a queued send write nothing.
    server.as('dev-b');
    await server.api.create({
      ...(server.posts[0] as ClipboardEventRequest),
      event_id: '11111111-2222-4333-8444-555555555555',
    });
    await e.refresh();
    server.setOffline(true);
    await e.capture('typed in the stale tab', 'manual');
    expect(await otherTab.events(USER)).toEqual([]);
    expect(await otherTab.queue(USER)).toEqual([]);
    expect(await otherTab.cursor(USER)).toBeNull();
    expect(JSON.stringify(await otherTab.events(USER))).not.toContain('ciphertext');
  });

  it('a queued capture says why: offline, server busy (5xx) or rate limited (429), or paused', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e } = engine(server, a);
    await e.start();
    server.setOffline(true);
    expect(await e.capture('one', 'manual')).toMatchObject({ kind: 'queued', reason: 'offline' });
    server.setOffline(false);
    await e.flush();
    await e.refresh();
    server.failOnce(new ApiError(503, 'unavailable', 'busy'));
    expect(await e.capture('two', 'manual')).toMatchObject({ kind: 'queued', reason: 'busy' });
    await e.flush();
    await e.refresh();
    server.failOnce(new ApiError(429, 'rate_limited', 'slow down'));
    expect(await e.capture('three', 'manual')).toMatchObject({ kind: 'queued', reason: 'rate_limited' });
    await e.flush();
    await e.refresh();
    server.setPaused(true);
    expect(await e.capture('four', 'manual')).toMatchObject({ kind: 'queued', reason: 'paused' });
  });

  it('a read refused with 429 (GET rate limit) is retried after Retry-After, not shown as a load failure', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const delays: number[] = [];
    const timers: (() => void)[] = [];
    let limited = true;
    const { e } = engine(server, a, {
      api: {
        ...server.api,
        history: async () => {
          if (limited) {
            limited = false;
            throw new ApiError(429, 'rate_limited', 'slow down', 7);
          }
          return server.api.history();
        },
      },
      setTimer: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
      },
    });
    await e.start();
    expect(e.snapshot().loadError).toBeNull();
    expect(e.snapshot().synced).toBe(false);
    expect(delays).toEqual([7000]);
    timers.shift()?.();
    await vi.waitFor(() => expect(e.snapshot().synced).toBe(true));
    expect(e.snapshot().loadError).toBeNull();
  });

  // QA round 2 (Phase 5B): the server notifies CLIPBOARD_EVENT_CREATED before it answers the create, and the runtime
  // refreshes on it, so a cursor pull can acknowledge an event before its own create response arrives. That late
  // acknowledgement is plain success; only events deleted on this device ever get a DELETE again.
  const deletedRows = (server: ReturnType<typeof fakeServer>) => [...server.rows.values()].filter((r) => r.deleted);

  it('QA r2: a refresh that pulls the event while its create response is held does not delete it', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const removes: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let hold = false;
    const { e } = engine(server, a, {
      api: {
        ...server.api,
        create: async (req) => {
          server.as('dev-a');
          const res = await server.api.create(req); // committed on the server
          if (hold) await gate; // the 201 is still on the wire
          return res;
        },
        remove: async (id) => {
          removes.push(id);
          return server.api.remove(id);
        },
      },
    });
    await e.start();
    hold = true;
    const cap = e.capture('hello world', 'manual');
    await vi.waitFor(() => expect(server.rows.size).toBe(1));
    await e.refresh(); // the WebSocket notification won the race
    expect(e.snapshot().queued).toBe(0);
    release();
    expect(await cap).toMatchObject({ kind: 'synced' });
    await e.flush();
    await vi.waitFor(() => expect(e.snapshot().syncing).toBe(false));
    expect(removes).toEqual([]);
    expect(deletedRows(server)).toEqual([]);
    expect(texts(e)).toEqual(['hello world']);
    expect(await a.store.queue(USER)).toEqual([]);
    expect(await a.store.deletes(USER)).toEqual([]);
  });

  it('QA r2: three captures queued offline, flushed online while each create triggers a refresh, stay on the server', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    let eng: ClipboardEngine | null = null;
    let notify = false;
    const { e } = engine(server, a, {
      api: {
        ...server.api,
        create: async (req) => {
          server.as('dev-a');
          const res = await server.api.create(req);
          if (notify) void eng?.refresh(); // CLIPBOARD_EVENT_CREATED arrives before the 201
          await new Promise((r) => setTimeout(r, 5));
          return res;
        },
      },
    });
    eng = e;
    await e.start();
    server.setOffline(true);
    for (const t of ['one', 'two', 'three']) await e.capture(t, 'manual');
    expect(e.snapshot().queued).toBe(3);
    server.setOffline(false);
    notify = true;
    await e.flush();
    await vi.waitFor(() => expect(e.snapshot().syncing).toBe(false));
    await e.refresh();
    expect(server.rows.size).toBe(3);
    expect(deletedRows(server)).toEqual([]);
    expect(texts(e)).toEqual(['three', 'two', 'one']);
    expect(e.snapshot().queued).toBe(0);
  });

  it('QA r2: two tabs sending the same queued capture never delete it', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const removes: string[] = [];
    const spy = { ...server.api, remove: async (id: string) => (removes.push(id), server.api.remove(id)) };
    const { e: tabA } = engine(server, a, {
      api: { ...spy, create: (r) => (server.as('dev-a'), server.api.create(r)) },
    });
    await tabA.start();
    server.setOffline(true);
    await tabA.capture('typed offline', 'manual');
    // Tab B opens on the same browser profile (same IndexedDB) and reads the same queue; its creates are answered
    // after a refresh it triggers itself, so its pull acknowledges first.
    let tabBRef: ClipboardEngine | null = null;
    const { e: tabB } = engine(
      server,
      { ...a, store: openClipboardStore(a.factory) },
      {
        api: {
          ...spy,
          create: async (r) => {
            server.as('dev-a');
            const res = await server.api.create(r);
            await tabBRef?.refresh();
            return res;
          },
        },
      },
    );
    tabBRef = tabB;
    await tabB.start();
    expect(tabB.snapshot().queued).toBe(1);
    server.setOffline(false);
    await Promise.all([tabA.flush(), tabB.flush()]);
    await Promise.all([tabA.refresh(), tabB.refresh()]);
    expect(server.rows.size).toBe(1);
    expect(removes).toEqual([]);
    expect(deletedRows(server)).toEqual([]);
    expect(texts(tabA)).toEqual(['typed offline']);
    expect(texts(tabB)).toEqual(['typed offline']);
    expect(await a.store.queue(USER)).toEqual([]);
  });

  it('a queued capture deleted here while its create is in flight is deleted again when the create lands late', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let hold = false;
    const { e } = engine(server, a, {
      api: {
        ...server.api,
        create: async (req) => {
          if (hold) await gate; // not committed yet when the DELETE arrives
          server.as('dev-a');
          return server.api.create(req);
        },
      },
    });
    await e.start();
    hold = true;
    const cap = e.capture('oops', 'manual');
    await vi.waitFor(() => expect(e.snapshot().items).toHaveLength(1));
    const id = e.snapshot().items[0]?.id ?? '';
    const removing = e.remove(id); // DELETE answers 404: nothing on the server yet
    await vi.waitFor(async () => expect(await a.store.deletes(USER)).toHaveLength(1));
    release();
    await cap;
    await removing;
    await vi.waitFor(() => expect(server.rows.get(id)?.deleted).toBe(true));
    await e.refresh();
    expect(e.snapshot().items).toEqual([]);
    expect(await a.store.deletes(USER)).toEqual([]);
  });

  it('QA r2: deleting a queued capture offline keeps a durable pending delete, retried until 204', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    let loseNext = true;
    const create = async (req: ClipboardEventRequest) => {
      server.as('dev-a');
      const res = await server.api.create(req);
      if (loseNext) {
        loseNext = false;
        throw new NetworkError(); // stored on the server, the response is lost
      }
      return res;
    };
    const { e } = engine(server, a, { api: { ...server.api, create } });
    await e.start();
    const r = await e.capture('stored but unacknowledged', 'manual');
    expect(r.kind).toBe('queued');
    const id = (r as { id: string }).id;
    server.setOffline(true);
    await e.remove(id);
    expect(texts(e)).toEqual([]);
    expect(await a.store.queue(USER)).toEqual([]);
    expect((await a.store.deletes(USER)).map((d) => d.event_id)).toEqual([id]);
    e.stop();
    // A reload while still offline: the pending delete is read back, the row stays hidden; back online, a refresh that
    // sees the row live does not bring it back, and the retried DELETE removes it everywhere.
    const { e: again } = engine(server, a, { api: { ...server.api, create } });
    await again.start();
    expect(texts(again)).toEqual([]);
    server.setOffline(false);
    await again.refresh();
    expect(texts(again)).toEqual([]);
    await again.flush();
    await vi.waitFor(() => expect(server.rows.get(id)?.deleted).toBe(true));
    expect(await a.store.deletes(USER)).toEqual([]);
    await again.refresh();
    expect(texts(again)).toEqual([]);
  });

  it('a pending delete answered 404 is kept for the grace period, then settled by one last DELETE', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    let clock = Date.now();
    const removes: string[] = [];
    const { e } = engine(server, a, {
      now: () => clock,
      api: { ...server.api, remove: async (id) => (removes.push(id), server.api.remove(id)) },
    });
    await e.start();
    server.setOffline(true);
    await e.capture('never reached the server', 'manual');
    const id = e.snapshot().items[0]?.id ?? '';
    await e.remove(id);
    expect(removes).toEqual([id]); // tried at once, offline
    server.setOffline(false);
    await e.flush();
    expect(removes).toEqual([id, id]); // 404: a create could still be in flight in another tab
    expect((await a.store.deletes(USER))[0]?.due).toBe(clock + DELETE_GRACE_MS);
    await e.flush();
    expect(removes).toHaveLength(2);
    clock += DELETE_GRACE_MS;
    await e.flush();
    expect(removes).toEqual([id, id, id]);
    expect(await a.store.deletes(USER)).toEqual([]);
    expect(server.rows.size).toBe(0);
    expect(server.posts).toHaveLength(0);
  });

  it('a pending delete refused for now (5xx) is retried later and does not hold up the queue', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    let failDeletes = true;
    let clock = Date.now();
    const { e, timers } = engine(server, a, {
      now: () => clock,
      api: {
        ...server.api,
        remove: async (id) => {
          if (failDeletes) throw new ApiError(503, 'unavailable', 'busy');
          return server.api.remove(id);
        },
      },
    });
    await e.start();
    server.setOffline(true);
    await e.capture('delete me', 'manual');
    const id = e.snapshot().items[0]?.id ?? '';
    server.setOffline(false);
    await e.remove(id); // 503
    expect(server.posts).toHaveLength(0);
    expect(await a.store.deletes(USER)).toHaveLength(1);
    expect(await e.capture('sent anyway', 'manual')).toMatchObject({ kind: 'synced' });
    expect(timers.length).toBeGreaterThan(0);
    failDeletes = false;
    clock += DELETE_GRACE_MS; // the create never reached the server: its 404 settles it once the grace has passed
    for (const t of timers.splice(0)) t();
    await vi.waitFor(async () => expect(await a.store.deletes(USER)).toEqual([]));
    expect(server.rows.has(id)).toBe(false);
    expect(texts(e)).toEqual(['sent anyway']);
  });

  it('QA r2: Clear history drops queued captures; none is sent after it, even after sync resumes', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    let clock = Date.now();
    const { e, timers } = engine(server, a, { now: () => clock });
    await e.start();
    await e.capture('synced one', 'manual');
    server.setOffline(true);
    expect(await e.capture('queued offline', 'manual')).toMatchObject({ kind: 'queued' });
    server.setOffline(false);
    server.setPaused(true); // the account was paused elsewhere: the next capture stays queued with 409
    expect(await e.capture('queued while paused', 'manual')).toMatchObject({ kind: 'queued', reason: 'paused' });
    server.setPaused(false);
    const postsBefore = server.posts.length;
    await e.clear();
    expect(e.snapshot().items).toEqual([]);
    expect(e.snapshot().queued).toBe(0);
    expect(await a.store.queue(USER)).toEqual([]);
    e.applySettings({ paused: false, retention_days: 7, sensitive_skip: true });
    for (const t of timers.splice(0)) t();
    await e.flush();
    clock += DELETE_GRACE_MS;
    await e.flush();
    await e.refresh();
    expect(server.posts).toHaveLength(postsBefore); // nothing queued was sent after the clear
    expect(server.rows.size).toBe(1); // only "synced one" ever reached the server (the paused 409 stored nothing)
    expect([...server.rows.values()].every((r) => r.deleted)).toBe(true);
    expect(e.snapshot().items).toEqual([]);
    expect(await a.store.deletes(USER)).toEqual([]);
  });

  it('Clear history in one tab: another tab holding the same queue does not send it afterwards', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const { e: tabA } = engine(server, a);
    await tabA.start();
    server.setOffline(true);
    await tabA.capture('queued in both tabs', 'manual');
    const { e: tabB } = engine(server, { ...a, store: openClipboardStore(a.factory) });
    await tabB.start();
    await tabB.flush(); // its first pass ran offline
    expect(tabB.snapshot().queued).toBe(1);
    server.setOffline(false);
    await tabA.clear();
    await tabB.flush();
    expect(server.posts).toHaveLength(0);
    expect(tabB.snapshot().queued).toBe(0);
    expect(tabB.snapshot().items).toEqual([]);
  });

  it('a capture made while Clear history runs is kept and sent after it', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { e } = engine(server, a, {
      api: {
        ...server.api,
        create: (r) => (server.as('dev-a'), server.api.create(r)),
        clear: async () => {
          await gate;
          return server.api.clear();
        },
      },
    });
    await e.start();
    await e.capture('before the clear', 'manual');
    const clearing = e.clear();
    expect(await e.capture('during the clear', 'manual')).toMatchObject({ kind: 'queued' });
    expect(server.posts).toHaveLength(1);
    release();
    await clearing;
    await e.flush();
    await e.refresh();
    expect(texts(e)).toEqual(['during the clear']);
    expect([...server.rows.values()].filter((r) => !r.deleted)).toHaveLength(1);
  });

  describe('QA r3: every tab keeps a correct timeline although they share one cursor (§2.9)', () => {
    const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
    /** Another tab of the same browser: its own connection to the same IndexedDB. */
    const tabOf = (d: Device): Device => ({ ...d, store: openClipboardStore(d.factory) });

    it('T1: an event another tab pulled first (moving the shared cursor) is shown in this tab too', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      const c = await device('dev-c', [adk1]);
      const { e: tabA } = engine(server, a);
      const { e: tabB } = engine(server, tabOf(a));
      const { e: devC } = engine(server, c);
      await tabA.start();
      await tabB.start();
      await devC.start();
      await devC.capture('from phone', 'manual');
      await tabB.refresh();
      expect(await a.store.cursor(USER)).toBe(1);
      await tabA.refresh();
      expect(texts(tabA)).toEqual(['from phone']);
      expect(texts(tabB)).toEqual(['from phone']);
      expect(tabA.snapshot().items[0]?.incoming).toBe(true);
    });

    it('T2: a deletion another tab pulled first also removes the row in this tab', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      const c = await device('dev-c', [adk1]);
      const { e: tabA } = engine(server, a);
      const { e: tabB } = engine(server, tabOf(a));
      const { e: devC } = engine(server, c);
      await tabA.start();
      await tabB.start();
      await devC.start();
      const r = await devC.capture('secret-ish text', 'manual');
      await tabA.refresh();
      await tabB.refresh();
      expect(texts(tabA)).toEqual(['secret-ish text']);
      await devC.remove((r as { id: string }).id);
      await tabB.refresh();
      await tabA.refresh();
      expect(texts(tabA)).toEqual([]);
      expect(texts(tabB)).toEqual([]);
      expect(await a.store.events(USER)).toEqual([]);
    });

    it('T3: a queued capture deleted in tab B while tab A has its create in flight leaves no ghost anywhere', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      let hold = false;
      const { e: tabA } = engine(server, a, {
        api: {
          ...server.api,
          create: async (req) => {
            server.as('dev-a');
            const res = await server.api.create(req);
            if (hold) await gate;
            return res;
          },
        },
      });
      await tabA.start();
      server.setOffline(true);
      const id = ((await tabA.capture('typed offline', 'manual')) as { id: string }).id;
      const { e: tabB } = engine(server, tabOf(a));
      await tabB.start();
      expect(tabB.snapshot().queued).toBe(1);
      server.setOffline(false);
      hold = true;
      const sending = tabA.flush();
      await tick();
      expect(server.rows.get(id)?.deleted).toBe(false); // the create committed; its response is held
      await tabB.remove(id); // DELETE 204, and tab B pulls the tombstone (the shared cursor passes it)
      await tick();
      release();
      await sending;
      await tick();
      await tabA.refresh();
      expect(server.rows.get(id)?.deleted).toBe(true);
      expect(texts(tabA)).toEqual([]);
      expect(texts(tabB)).toEqual([]);
      expect(await a.store.events(USER)).toEqual([]);
      const { e: fresh } = engine(server, tabOf(a));
      await fresh.start();
      expect(texts(fresh)).toEqual([]);
    });

    it('T4: lost response, deleted on another device, tombstone pulled by tab B, tab A retries: no ghost', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      const c = await device('dev-c', [adk1]);
      let lose = true;
      const { e: tabA } = engine(server, a, {
        api: {
          ...server.api,
          create: async (req) => {
            server.as('dev-a');
            const res = await server.api.create(req);
            if (lose) {
              lose = false;
              throw new NetworkError();
            }
            return res;
          },
        },
      });
      const { e: tabB } = engine(server, tabOf(a));
      const { e: devC } = engine(server, c);
      await tabA.start();
      await tabB.start();
      await devC.start();
      const r = await tabA.capture('lost ack', 'manual');
      expect(r.kind).toBe('queued');
      const id = (r as { id: string }).id;
      await devC.refresh();
      await devC.remove(id);
      await tabB.refresh(); // the creation and the tombstone: the shared cursor moves past both
      await tabA.flush(); // the retry is answered with the tombstone's seq
      await tick();
      await tabA.refresh();
      expect(texts(tabA)).toEqual([]);
      expect(await a.store.events(USER)).toEqual([]);
      expect(await a.store.queue(USER)).toEqual([]);
      const { e: fresh } = engine(server, tabOf(a));
      await fresh.start();
      expect(texts(fresh)).toEqual([]);
      expect(fresh.snapshot().queued).toBe(0);
    });

    it('T5: Clear history in tab A also drops a capture tab B queued after tab A started', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      const { e: tabA } = engine(server, a);
      const { e: tabB } = engine(server, tabOf(a));
      await tabA.start();
      await tabB.start();
      server.setOffline(true);
      await tabB.capture('queued in B', 'manual');
      server.setOffline(false);
      // Tab B's retry has not run yet when tab A clears.
      await tabA.clear();
      await tabB.flush();
      await tick();
      expect(server.posts).toHaveLength(0);
      expect([...server.rows.values()].filter((x) => !x.deleted)).toHaveLength(0);
      expect(texts(tabB)).toEqual([]);
      expect((await a.store.deletes(USER)).map((d) => d.event_id)).toHaveLength(1);
    });

    it('T6: a capture made while Clear waits for a send in flight is kept and sent after it', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      let hold = false;
      const { e } = engine(server, a, {
        api: {
          ...server.api,
          create: async (req) => {
            server.as('dev-a');
            const res = await server.api.create(req);
            if (hold) {
              hold = false;
              await gate;
            }
            return res;
          },
        },
      });
      await e.start();
      hold = true;
      const first = e.capture('first', 'manual');
      await tick();
      const clearing = e.clear();
      await tick();
      const second = e.capture('typed after pressing clear', 'manual');
      await tick();
      release();
      expect(await second).toMatchObject({ kind: 'queued' });
      await first;
      await clearing;
      await tick();
      await e.flush();
      await e.refresh();
      const live = [...server.rows.values()].filter((x) => !x.deleted);
      expect(live).toHaveLength(1);
      expect(texts(e)).toEqual(['typed after pressing clear']);
    });
  });

  describe('QA r4: Clear, acknowledgements and reloads racing with pulls and captures (§2.9)', () => {
    const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
    const tabOf = (d: Device): Device => ({ ...d, store: openClipboardStore(d.factory) });
    const shownIds = (e: ClipboardEngine) =>
      e
        .snapshot()
        .items.filter((i) => !i.pending)
        .map((i) => i.id)
        .sort();
    const liveIds = (s: ReturnType<typeof fakeServer>) =>
      [...s.rows.values()]
        .filter((r) => !r.deleted)
        .map((r) => r.event_id)
        .sort();

    it('N1: an event created on another device right after the server cleared, pulled before the 204, is kept', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      const c = await device('dev-c', [adk1]);
      const { e: devC } = engine(server, c);
      let tab: ClipboardEngine | null = null;
      let newId = '';
      const { e } = engine(server, a, {
        api: {
          ...server.api,
          clear: async () => {
            await server.api.clear();
            // The phone captures right after the server clear; its notification makes this tab pull before the 204.
            const r = await devC.capture('captured on phone right after the clear', 'manual');
            newId = (r as { id: string }).id;
            await tab?.refresh();
          },
        },
      });
      tab = e;
      await devC.start();
      await e.start();
      await devC.capture('old one', 'manual');
      await e.refresh();
      expect(texts(e)).toEqual(['old one']);
      await e.clear();
      await tick();
      await e.refresh();
      expect(liveIds(server)).toEqual([newId]);
      expect(shownIds(e)).toEqual([newId]);
      expect((await a.store.events(USER)).map((x) => x.event_id)).toEqual([newId]);
      const { e: fresh } = engine(server, tabOf(a));
      await fresh.start();
      expect(shownIds(fresh)).toEqual([newId]);
    });

    for (const mode of ['micro1', 'micro5', 'setImmediate'] as const) {
      it(`N2 (${mode}): a tombstone pulled while the acknowledgement is applied in the store leaves no ghost`, async () => {
        const server = fakeServer();
        const a = await device('dev-a', [adk1]);
        let tab: ClipboardEngine | null = null;
        let releaseEvents: () => void = () => undefined;
        let gateOn = false;
        let pulling: Promise<void> | null = null;
        const later = (fn: () => void) => {
          if (mode === 'micro1') queueMicrotask(fn);
          else if (mode === 'micro5') {
            let p = Promise.resolve();
            for (let i = 0; i < 5; i++) p = p.then(() => undefined);
            void p.then(fn);
          } else setImmediate(fn);
        };
        const { e } = engine(server, a, {
          api: {
            ...server.api,
            events: async (cursor, limit) => {
              if (gateOn) await new Promise<void>((r) => (releaseEvents = r));
              return server.api.events(cursor, limit);
            },
            create: async (req) => {
              server.as('dev-a');
              const res = await server.api.create(req);
              await server.api.remove(req.event_id); // another device deletes it at once
              gateOn = true;
              pulling = tab?.refresh() ?? null; // the notifications start a pull; its page is held
              await tick(5);
              gateOn = false;
              later(() => releaseEvents()); // the page arrives while the acknowledgement is being applied
              return res;
            },
          },
        });
        tab = e;
        await e.start();
        expect((await e.capture('deleted elsewhere at once', 'manual')).kind).toBe('synced');
        await pulling;
        await tick(30);
        expect(texts(e)).toEqual([]);
        expect(await a.store.events(USER)).toEqual([]);
        await e.refresh();
        expect(texts(e)).toEqual([]);
        const { e: fresh } = engine(server, tabOf(a));
        await fresh.start();
        expect(texts(fresh)).toEqual([]);
      });
    }

    it('N3: a first send answered with a tombstone seq beyond the cursor clears without a notification', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      let releaseA: () => void = () => undefined;
      const gateA = new Promise<void>((r) => (releaseA = r));
      let holdA = true;
      const { e: tabA } = engine(server, a, {
        api: {
          ...server.api,
          create: async (req) => {
            if (holdA) {
              holdA = false;
              await gateA;
            }
            server.as('dev-a');
            return server.api.create(req);
          },
        },
      });
      await tabA.start();
      const capturing = tabA.capture('sent by two tabs', 'manual');
      await tick();
      // Tab B opens now, reads the shared queue and sends it first (its response is held); the phone deletes it.
      let releaseB: () => void = () => undefined;
      const gateB = new Promise<void>((r) => (releaseB = r));
      const { e: tabB } = engine(server, tabOf(a), {
        api: {
          ...server.api,
          create: async (req) => {
            server.as('dev-a');
            const res = await server.api.create(req);
            await gateB;
            return res;
          },
        },
      });
      const bStarting = tabB.start();
      await tick();
      const id = [...server.rows.keys()][0] ?? '';
      await server.api.remove(id);
      const cursorsBefore = server.cursorsSent.length;
      releaseA(); // tab A's first create is answered with the tombstone's seq (2), beyond its cursor (0)
      expect((await capturing).kind).toBe('synced');
      await tick();
      // No notification, focus or explicit refresh: the acknowledgement itself made tab A follow the cursor.
      expect(server.cursorsSent.length).toBeGreaterThan(cursorsBefore);
      expect(texts(tabA)).toEqual([]);
      releaseB();
      await bStarting;
      await tick();
      expect(texts(tabA)).toEqual([]);
      expect(texts(tabB)).toEqual([]);
      expect(await a.store.events(USER)).toEqual([]);
    });

    for (const delay of [-1, 0, 1, 2, 4]) {
      it(`N4 (delay ${delay}): a capture made while the tab reloads from the shared cache is kept and sent`, async () => {
        const server = fakeServer();
        const a = await device('dev-a', [adk1]);
        let mode: 'ok' | 'lose' | 'down' = 'ok';
        const { e: tabA } = engine(server, a, {
          api: {
            ...server.api,
            create: async (req) => {
              if (mode === 'down') throw new NetworkError();
              server.as('dev-a');
              const res = await server.api.create(req);
              if (mode === 'lose') throw new NetworkError();
              return res;
            },
          },
        });
        const { e: tabB } = engine(server, tabOf(a));
        await tabA.start();
        await tabB.start();
        mode = 'lose';
        expect((await tabA.capture('q1 response lost', 'manual')).kind).toBe('queued');
        mode = 'down';
        await tabB.refresh(); // tab B pulls q1 and moves the shared cursor
        const reloading = tabA.refresh(); // tab A sees the moved cursor and reloads from the shared cache
        if (delay >= 0) await tick(delay);
        const q2 = await tabA.capture('q2 typed during the reload', 'manual');
        // Never reported as synced: the server has not acknowledged it.
        expect(q2).toMatchObject({ kind: 'queued', reason: 'offline' });
        await reloading;
        await tick();
        const id = (q2 as { id: string }).id;
        expect(tabA.snapshot().items.some((i) => i.id === id && i.pending)).toBe(true);
        expect((await a.store.queue(USER)).map((x) => x.event_id)).toContain(id);
        mode = 'ok';
        await tabA.flush();
        await tick();
        expect(server.rows.get(id)?.deleted).toBe(false);
        expect(tabA.snapshot().queued).toBe(0);
      });
    }

    it('a capture deleted here before the server acknowledged it is reported as removed, never as synced', async () => {
      const server = fakeServer();
      const a = await device('dev-a', [adk1]);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const { e } = engine(server, a, {
        api: {
          ...server.api,
          create: async (req) => {
            await gate;
            server.as('dev-a');
            return server.api.create(req);
          },
        },
      });
      await e.start();
      const capturing = e.capture('deleted while sending', 'manual');
      await tick();
      const id = e.snapshot().items[0]?.id ?? '';
      const removing = e.remove(id);
      await tick();
      release();
      expect(await capturing).toEqual({ kind: 'removed', id });
      await removing;
      await tick();
      await e.flush();
      expect(server.rows.get(id)?.deleted).toBe(true);
      expect(texts(e)).toEqual([]);
    });
  });
});
