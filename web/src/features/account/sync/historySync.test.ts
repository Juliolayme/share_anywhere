// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { generateAdk, openKeyStore, type KeyStore } from '../../../lib/crypto';
import { NetworkError } from '../../../lib/api/errors';
import { openHistoryStore, type HistoryEntry, type HistoryStore } from '../../history/store/history-store';
import type { AccountApi, RemoteHistoryEntry } from '../api';
import { clearSynced, deleteSynced, entryUuid, parseEntry, syncHistory, syncedId, type SyncDeps } from './historySync';
import { openSyncMeta, type SyncMetaStore } from './syncMeta';

/** In-memory stand-in for the history endpoints (docs/API.md §2.4 "History"): seq per account, tombstones. */
function fakeServer() {
  let seq = 0;
  const rows = new Map<string, RemoteHistoryEntry>();
  const bodies: string[] = [];
  let offline = false;
  const guard = () => {
    if (offline) throw new NetworkError();
  };
  const api = {
    historyEntries: async (after: number, limit = 200) => {
      guard();
      const entries = [...rows.values()]
        .filter((r) => r.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      return { entries, next_after: entries.length ? (entries[entries.length - 1]?.seq ?? after) : after };
    },
    addHistoryEntry: async (req: { entry_id: string; key_version: number; nonce: string; ciphertext: string }) => {
      guard();
      bodies.push(JSON.stringify(req));
      const existing = rows.get(req.entry_id);
      if (existing) return { seq: existing.seq };
      seq++;
      rows.set(req.entry_id, {
        ...req,
        seq,
        origin_device_id: current.device,
        created_at: new Date().toISOString(),
        deleted: false,
      });
      return { seq };
    },
    deleteHistoryEntry: async (id: string) => {
      guard();
      const r = rows.get(id);
      if (!r || r.deleted) return undefined;
      seq++;
      rows.set(id, {
        entry_id: id,
        seq,
        key_version: r.key_version,
        origin_device_id: r.origin_device_id,
        created_at: r.created_at,
        deleted: true,
      });
      return undefined;
    },
    clearHistory: async () => {
      guard();
      for (const id of [...rows.keys()]) await api.deleteHistoryEntry(id);
      return undefined;
    },
  };
  const current = { device: '' };
  return {
    api: api as unknown as AccountApi,
    rows,
    bodies,
    as: (device: string) => (current.device = device),
    setOffline: (v: boolean) => (offline = v),
  };
}

interface Dev {
  id: string;
  keys: KeyStore;
  history: HistoryStore;
  meta: SyncMetaStore;
}

const memoryPrefs = () => {
  const m = new Map<string, string>();
  return { read: (k: string) => m.get(k) ?? null, write: (k: string, v: string) => void m.set(k, v) };
};

async function device(id: string, adks: { version: number; raw: Uint8Array }[]): Promise<Dev> {
  const factory = new IDBFactory();
  const keys = await openKeyStore({ factory });
  for (const a of adks) await keys.saveAdk(a.version, a.raw);
  return { id, keys, history: openHistoryStore(factory, memoryPrefs()), meta: openSyncMeta(factory) };
}

const entry = (id: string, title: string, createdAt = Date.now()): HistoryEntry => ({
  id,
  direction: 'sent',
  title,
  fileCount: 1,
  totalBytes: 2048,
  peer: 'Lan',
  status: 'completed',
  createdAt,
  files: [{ name: title, size: 2048 }],
});

function deps(server: ReturnType<typeof fakeServer>, d: Dev, enabled = true): SyncDeps {
  server.as(d.id);
  return {
    api: server.api,
    keys: d.keys,
    history: d.history,
    meta: d.meta,
    userId: 'u1',
    deviceId: d.id,
    enabled,
    deviceNames: new Map([
      ['dev-a', 'Desk A'],
      ['dev-b', 'Phone B'],
    ]),
  };
}

const adk1 = generateAdk(1);

describe('cloud history sync', () => {
  it('encrypts entries for the account and decrypts them on another device, once', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const b = await device('dev-b', [adk1]);
    await a.meta.put({ ...(await a.meta.get('u1')), pushSince: 0 });
    await a.history.add(entry('tx:s1', 'report.pdf'));

    expect(await syncHistory(deps(server, a))).toMatchObject({ pushed: 1, pulled: 0 });
    // The server only ever sees ciphertext.
    expect(server.bodies.join()).not.toContain('report.pdf');
    expect(server.bodies.join()).not.toContain('Lan');

    expect(await syncHistory(deps(server, b))).toMatchObject({ pushed: 0, pulled: 1 });
    const [pulled] = await b.history.list();
    expect(pulled?.title).toBe('report.pdf');
    expect(pulled?.origin).toBe('Desk A');
    expect(pulled?.id).toBe(syncedId([...server.rows.keys()][0] ?? ''));

    // Idempotent: no re-upload, no duplicate, and A does not pull its own entry back.
    expect(await syncHistory(deps(server, a))).toMatchObject({ pushed: 0, pulled: 0 });
    expect(await syncHistory(deps(server, b))).toMatchObject({ pushed: 0, pulled: 0 });
    expect(await a.history.list()).toHaveLength(1);
    expect(await b.history.list()).toHaveLength(1);
  });

  it('uploads history from before sign-in only through the one-time import', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const now = Date.now();
    await a.history.add(entry('rx:old', 'old.zip', now - 86_400_000));
    await a.meta.put({ ...(await a.meta.get('u1')), pushSince: now - 1000 });
    await a.history.add(entry('rx:new', 'new.zip', now));
    expect((await syncHistory(deps(server, a))).pushed).toBe(1);
    await a.meta.put({ ...(await a.meta.get('u1')), importPending: true });
    // The import runs even while sync is off, and only once.
    expect((await syncHistory(deps(server, a, false))).pushed).toBe(1);
    expect((await a.meta.get('u1')).importPending).toBe(false);
    expect((await syncHistory(deps(server, a))).pushed).toBe(0);
    expect(server.rows.size).toBe(2);
  });

  it('with sync off nothing is uploaded or pulled', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    await a.meta.put({ ...(await a.meta.get('u1')), pushSince: 0 });
    await a.history.add(entry('tx:s1', 'x.pdf'));
    expect(await syncHistory(deps(server, a, false))).toMatchObject({ pushed: 0, pulled: 0 });
    expect(server.rows.size).toBe(0);
  });

  it('deletions travel as tombstones both ways; Clear all tombstones everything; offline deletes wait', async () => {
    const server = fakeServer();
    const a = await device('dev-a', [adk1]);
    const b = await device('dev-b', [adk1]);
    await a.meta.put({ ...(await a.meta.get('u1')), pushSince: 0 });
    await a.history.add(entry('tx:1', 'one.pdf'));
    await a.history.add(entry('tx:2', 'two.pdf'));
    await a.history.add(entry('tx:3', 'three.pdf'));
    await syncHistory(deps(server, a));
    await syncHistory(deps(server, b));
    expect(await b.history.list()).toHaveLength(3);

    // B deletes a pulled entry: the original on A goes too.
    const one = (await b.history.list()).find((e) => e.title === 'one.pdf');
    await b.history.remove(one?.id ?? '');
    await deleteSynced(deps(server, b), [one?.id ?? '']);
    expect((await syncHistory(deps(server, a))).removed).toBe(1);
    expect((await a.history.list()).map((e) => e.title).sort()).toEqual(['three.pdf', 'two.pdf']);

    // A deletes its own entry while offline: queued, sent on the next pass, B removes its copy.
    await a.history.remove('tx:2');
    server.setOffline(true);
    await expect(deleteSynced(deps(server, a), ['tx:2'])).rejects.toBeInstanceOf(NetworkError);
    expect((await a.meta.get('u1')).pendingDeletes).toHaveLength(1);
    server.setOffline(false);
    await syncHistory(deps(server, a));
    expect((await a.meta.get('u1')).pendingDeletes).toHaveLength(0);
    await syncHistory(deps(server, b));
    expect((await b.history.list()).map((e) => e.title)).toEqual(['three.pdf']);

    // Clear all on B tombstones the rest of the account.
    await b.history.clear();
    await clearSynced(deps(server, b));
    expect([...server.rows.values()].every((r) => r.deleted)).toBe(true);
    await syncHistory(deps(server, a));
    expect(await a.history.list()).toEqual([]);
  });

  it('reads entries written with an older key version and counts the ones it cannot read', async () => {
    const server = fakeServer();
    const adk2 = generateAdk(2);
    const a = await device('dev-a', [adk1]);
    await a.meta.put({ ...(await a.meta.get('u1')), pushSince: 0 });
    await a.history.add(entry('tx:v1', 'v1.pdf'));
    await syncHistory(deps(server, a));
    const both = await device('dev-b', [adk1, adk2]);
    expect((await syncHistory(deps(server, both))).pulled).toBe(1);
    const newer = await device('dev-c', [adk2]);
    expect(await syncHistory(deps(server, newer))).toMatchObject({ pulled: 0, unreadable: 1 });
  });

  it('validates decrypted entries and derives stable UUIDs per device', async () => {
    expect(parseEntry('not json')).toBeNull();
    expect(parseEntry(JSON.stringify({ direction: 'sideways' }))).toBeNull();
    const ok = parseEntry(
      JSON.stringify({ ...entry('x', 'a.txt'), route: 'warp', peers: ['a', 'b'], evil: '<script>' }),
    );
    expect(ok?.title).toBe('a.txt');
    expect(ok?.route).toBeUndefined();
    expect(ok).not.toHaveProperty('evil');
    const u = await entryUuid('tx:s1', 'dev-a');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await entryUuid('tx:s1', 'dev-a')).toBe(u);
    expect(await entryUuid('tx:s1', 'dev-b')).not.toBe(u);
  });
});
