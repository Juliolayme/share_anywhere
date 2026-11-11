import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  entryPeers,
  filterHistory,
  historyPeers,
  openHistoryStore,
  rangeStart,
  transferredOf,
  type HistoryEntry,
} from './history-store';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);
const entry = (id: string, ageDays: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  direction: 'sent',
  title: `${id}.mp4`,
  fileCount: 1,
  totalBytes: 1000,
  peer: 'Lan’s MacBook',
  status: 'completed',
  createdAt: NOW - ageDays * DAY,
  ...over,
});

beforeEach(() => localStorage.clear());

describe('history store', () => {
  it('adds, lists newest first, deletes, and clears', async () => {
    const store = openHistoryStore(new IDBFactory());
    await store.add(entry('a', 3));
    await store.add(entry('b', 1));
    await store.add(entry('c', 2));
    expect((await store.list()).map((e) => e.id)).toEqual(['b', 'c', 'a']);
    await store.remove('c');
    expect((await store.list()).map((e) => e.id)).toEqual(['b', 'a']);
    await store.add({ ...entry('b', 1), title: 'renamed' });
    expect((await store.list())[0]?.title).toBe('renamed');
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('sweeps entries past the retention period and everything for "Don’t keep"', async () => {
    const store = openHistoryStore(new IDBFactory());
    for (const [id, age] of [
      ['new', 1],
      ['month', 31],
      ['quarter', 95],
    ] as const)
      await store.add(entry(id, age));
    expect(await store.sweep('90', NOW)).toBe(1);
    expect((await store.list()).map((e) => e.id)).toEqual(['new', 'month']);
    expect(await store.sweep('30', NOW)).toBe(1);
    expect((await store.list()).map((e) => e.id)).toEqual(['new']);
    expect(await store.sweep('none', NOW)).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it('keeps data across reopen of the same database', async () => {
    const factory = new IDBFactory();
    await openHistoryStore(factory).add(entry('x', 0));
    expect((await openHistoryStore(factory).list()).map((e) => e.id)).toEqual(['x']);
  });
});

describe('history filters', () => {
  const all = [
    entry('trip', 0, { direction: 'received', peer: 'Minh’s Pixel 7' }),
    entry('report', 2, { status: 'failed' }),
    entry('old', 20, { status: 'partial' }),
  ];
  const base = { tab: 'all', query: '', status: 'any', range: 'all', peer: '' } as const;
  it('filters by tab, status, range, peer, and search', () => {
    const ids = (f: Partial<typeof base> | Record<string, string>) =>
      filterHistory(all, { ...base, ...f } as never, NOW).map((e) => e.id);
    expect(ids({ tab: 'received' })).toEqual(['trip']);
    expect(ids({ tab: 'sent', status: 'failed' })).toEqual(['report']);
    expect(ids({ range: '7d' })).toEqual(['trip', 'report']);
    expect(ids({ range: 'today' })).toEqual(['trip']);
    expect(ids({ peer: 'Minh’s Pixel 7' })).toEqual(['trip']);
    expect(ids({ query: 'REP' })).toEqual(['report']);
    expect(ids({ query: 'pixel' })).toEqual(['trip']);
  });
});

describe('history filters with Phase 4 fields', () => {
  const multi = entry('deck', 1, {
    title: 'deck.pdf',
    fileCount: 3,
    peer: 'Minh’s Pixel 7, Lan’s MacBook',
    peers: ['Minh’s Pixel 7', 'Lan’s MacBook'],
    files: [
      { name: 'deck.pdf', size: 10 },
      { name: 'notes.txt', size: 5 },
      { name: 'Wedding_photos.zip', size: 900 },
    ],
  });
  const legacy = entry('legacy', 2, { peer: 'Office PC' });
  const all = [multi, legacy];
  const f = { tab: 'all', query: '', status: 'any', range: 'all', peer: '' } as const;

  it('searches every recorded file name, not only the title', () => {
    expect(filterHistory(all, { ...f, query: 'wedding' }, NOW).map((e) => e.id)).toEqual(['deck']);
    expect(filterHistory(all, { ...f, query: 'office' }, NOW).map((e) => e.id)).toEqual(['legacy']);
    expect(filterHistory(all, { ...f, query: '  ' }, NOW)).toHaveLength(2);
  });

  it('filters by one peer of a multi-receiver entry and lists each peer once', () => {
    expect(filterHistory(all, { ...f, peer: 'Lan’s MacBook' }, NOW).map((e) => e.id)).toEqual(['deck']);
    expect(historyPeers(all)).toEqual(['Lan’s MacBook', 'Minh’s Pixel 7', 'Office PC']);
    expect(entryPeers(legacy)).toEqual(['Office PC']);
    expect(entryPeers({ ...legacy, peers: [] })).toEqual(['Office PC']);
    expect(entryPeers({ ...legacy, peer: '' })).toEqual([]);
  });

  it('computes the date window for each preset', () => {
    expect(rangeStart('all', NOW)).toBe(0);
    expect(rangeStart('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(rangeStart('30d', NOW)).toBe(NOW - 30 * DAY);
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    expect(rangeStart('today', NOW)).toBe(today.getTime());
  });

  it('reports transferred bytes, or the size for a completed entry without them, or unknown', () => {
    expect(transferredOf(entry('a', 0, { status: 'partial', transferredBytes: 400 }))).toBe(400);
    expect(transferredOf(entry('b', 0))).toBe(1000);
    expect(transferredOf(entry('c', 0, { status: 'failed' }))).toBeUndefined();
  });

  it('stores and returns the optional fields unchanged', async () => {
    const store = openHistoryStore(new IDBFactory());
    await store.add({ ...multi, route: 'mixed', startedAt: multi.createdAt - 60_000 });
    const [back] = await store.list();
    expect(back?.files).toHaveLength(3);
    expect(back?.peers).toEqual(['Minh’s Pixel 7', 'Lan’s MacBook']);
    expect(back?.route).toBe('mixed');
  });
});

describe('deleted entries stay deleted', () => {
  it('a deleted or cleared entry is not written again, by this store or a new one (another tab, a reload)', async () => {
    const factory = new IDBFactory();
    const store = openHistoryStore(factory);
    await store.add(entry('tx:s1', 0));
    await store.add(entry('tx:s2', 0));
    await store.remove('tx:s1');
    await store.add({ ...entry('tx:s1', 0), status: 'partial' }); // the live session rewrites its result
    expect((await store.list()).map((e) => e.id)).toEqual(['tx:s2']);
    await store.clear();
    const reloaded = openHistoryStore(factory);
    await reloaded.add(entry('tx:s2', 0));
    await reloaded.add(entry('tx:s1', 0));
    expect(await reloaded.list()).toEqual([]);
    await reloaded.add(entry('tx:s3', 0)); // a new transfer is recorded
    expect((await reloaded.list()).map((e) => e.id)).toEqual(['tx:s3']);
  });
  it('without storage nothing is remembered, and the store still works', async () => {
    const store = openHistoryStore(new IDBFactory(), null);
    await store.add(entry('a', 0));
    await store.remove('a');
    await store.add(entry('a', 0));
    expect((await store.list()).map((e) => e.id)).toEqual(['a']);
  });
});

describe('deleted-id memory bounds', () => {
  it('keeps at most 500 ids and forgets them after seven days', async () => {
    const store = openHistoryStore(new IDBFactory());
    for (let i = 0; i < 510; i++) await store.remove(`id-${i}`);
    const kept = JSON.parse(localStorage.getItem('sa.pref.history.removed') ?? '{}') as Record<string, number>;
    expect(Object.keys(kept)).toHaveLength(500);
    // Seven days later the memory has expired: the id can be recorded again.
    localStorage.setItem('sa.pref.history.removed', JSON.stringify({ old: Date.now() - 8 * DAY }));
    await store.add(entry('old', 0));
    expect((await store.list()).map((e) => e.id)).toEqual(['old']);
  });
});
