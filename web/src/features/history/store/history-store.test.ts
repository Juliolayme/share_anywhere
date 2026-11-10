import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { filterHistory, openHistoryStore, type HistoryEntry } from './history-store';

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
