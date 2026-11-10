import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { openProgressStore, progressKey } from '../storage/progress-store';
import type { Transfer, TransferStatus, TransfersApi } from './api';
import { Reporter } from './reporter';
import { NEXT, pathTo, terminal } from './transitions';
import shared from '../../../../../shared/protocol/schemas/transfer-states.json';

describe('transitions mirror', () => {
  it('matches the shared table the server is tested against', () => {
    expect(NEXT).toEqual(shared.next);
  });

  it('walks to the target through allowed states', () => {
    expect(pathTo('PENDING', 'TRANSFERRING')).toEqual(['CONNECTING', 'TRANSFERRING']);
    expect(pathTo('DISCONNECTED', 'TRANSFERRING')).toEqual(['CONNECTING', 'TRANSFERRING']);
    expect(pathTo('RECONNECTING', 'TRANSFERRING')).toEqual(['RESUMING', 'TRANSFERRING']);
    expect(pathTo('TRANSFERRING', 'RECONNECTING')).toEqual(['DISCONNECTED', 'RECONNECTING']);
    // After a receiver reload the server still says TRANSFERRING; never detour through PAUSED.
    expect(pathTo('TRANSFERRING', 'CONNECTING')).toEqual(['DISCONNECTED', 'CONNECTING']);
    // Leaving PAUSED takes the resume action, not a report.
    expect(pathTo('PAUSED', 'TRANSFERRING')).toEqual([]);
    expect(pathTo('PAUSED', 'CONNECTING')).toEqual([]);
    expect(pathTo('PAUSED', 'CANCELLED')).toEqual(['CANCELLED']);
    expect(pathTo('TRANSFERRING', 'PAUSED')).toEqual(['PAUSED']);
    expect(pathTo('CONNECTING', 'COMPLETED')).toEqual(['TRANSFERRING', 'COMPLETED']);
    expect(pathTo('COMPLETED', 'TRANSFERRING')).toEqual([]);
    expect(pathTo('TRANSFERRING', 'TRANSFERRING')).toEqual([]);
  });

  it('every reported walk is one the server accepts and passes through PAUSED only as the destination', () => {
    const all = Object.keys(NEXT) as TransferStatus[];
    for (const from of all.filter((s) => !terminal(s)))
      for (const to of all) {
        const path = pathTo(from, to);
        let cur: TransferStatus = from;
        for (const [i, step] of path.entries()) {
          expect(NEXT[cur]).toContain(step);
          // Server rule (backend/internal/transfers/service.go): a report cannot leave PAUSED except to end.
          expect(cur === 'PAUSED' && !terminal(step)).toBe(false);
          if (step === 'PAUSED') expect(i).toBe(path.length - 1);
          cur = step;
        }
      }
  });

  it('terminal states have no exits', () => {
    for (const s of ['COMPLETED', 'FAILED', 'CANCELLED'] as TransferStatus[]) {
      expect(terminal(s)).toBe(true);
      expect(NEXT[s]).toEqual([]);
    }
  });
});

function fakeApi() {
  const calls: Array<[string, TransferStatus, number]> = [];
  const api = {
    report: vi.fn(async (id: string, status: TransferStatus, verified: number) => {
      calls.push([id, status, verified]);
      return { id, status, verified_bytes: verified } as Transfer;
    }),
  } as unknown as TransfersApi;
  return { api, calls };
}

describe('Reporter', () => {
  it('reports state changes in order, through intermediate states', async () => {
    const { api, calls } = fakeApi();
    const r = new Reporter(api, 2000);
    r.seed('t1', 'TRANSFERRING', 100);
    await r.state('t1', 'RECONNECTING', 100);
    await r.state('t1', 'TRANSFERRING', 200);
    expect(calls.map((c) => c[1])).toEqual(['DISCONNECTED', 'RECONNECTING', 'RESUMING', 'TRANSFERRING']);
    expect(calls.at(-1)?.[2]).toBe(200);
  });

  it('throttles progress to one report per interval and never goes backwards', async () => {
    vi.useFakeTimers();
    const { api, calls } = fakeApi();
    let now = 0;
    const r = new Reporter(api, 2000, () => now);
    r.seed('t1', 'TRANSFERRING', 0);
    for (let i = 1; i <= 10; i++) r.progress('t1', i * 10);
    r.progress('t1', 5); // late, smaller value is ignored
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([['t1', 'TRANSFERRING', 100]]);
    now = 1000;
    r.progress('t1', 150);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
    now = 2000;
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.at(-1)).toEqual(['t1', 'TRANSFERRING', 150]);
    vi.useRealTimers();
  });

  it('leaves PAUSED only through the resume hook, and stays paused when the hook declines', async () => {
    const { api, calls } = fakeApi();
    const r = new Reporter(api);
    r.seed('t1', 'PAUSED', 10);
    await r.state('t1', 'CONNECTING', 10);
    expect(calls).toEqual([]); // no hook: nothing the server would refuse is sent
    const resume = vi.fn(async () => null);
    r.resume = resume;
    await r.state('t1', 'CONNECTING', 10);
    expect(resume).toHaveBeenCalledWith('t1');
    expect(calls).toEqual([]);
    r.resume = async () => ({ status: 'RESUMING' as TransferStatus, verified_bytes: 10 });
    await r.state('t1', 'TRANSFERRING', 20);
    expect(calls.map((c) => c[1])).toEqual(['TRANSFERRING']);
    expect(r.current('t1')).toBe('TRANSFERRING');
  });

  it('stops at terminal states', async () => {
    const { api, calls } = fakeApi();
    const r = new Reporter(api);
    r.seed('t1', 'COMPLETED', 10);
    await r.state('t1', 'FAILED');
    expect(calls).toEqual([]);
  });
});

describe('progress store', () => {
  it('keeps bitmaps per capability and transfer, lists and removes by session, remembers the save target', async () => {
    const store = openProgressStore(new IDBFactory());
    const key = progressKey('abc', 't1');
    expect(key).toBe('abc:t1');
    await store.put({
      key,
      sessionId: 's1',
      transferId: 't1',
      name: 'a.bin',
      size: 10,
      blockSize: 4,
      bitmap: new Uint8Array([0b101]),
      staging: 't1',
      verified: false,
      updatedAt: 1,
    });
    await store.put({
      key: progressKey('abc', 't2'),
      sessionId: 's2',
      transferId: 't2',
      name: 'b',
      size: 1,
      blockSize: 4,
      bitmap: new Uint8Array([0]),
      staging: 't2',
      verified: false,
      updatedAt: 1,
    });
    expect(Array.from((await store.get(key))?.bitmap ?? [])).toEqual([0b101]);
    expect((await store.forSession('s1')).map((p) => p.transferId)).toEqual(['t1']);
    await store.putTarget({ sessionId: 's1', mode: 'opfs' });
    expect(await store.getTarget('s1')).toEqual({ sessionId: 's1', mode: 'opfs' });
    await store.removeSession('s1');
    expect(await store.get(key)).toBeUndefined();
    expect(await store.getTarget('s1')).toBeUndefined();
    expect(await store.get(progressKey('abc', 't2'))).toBeDefined();
  });
});

describe('storage sweep', () => {
  it('drops progress older than 24 hours with its staging file and keeps recent ones', async () => {
    const { sweepStorage } = await import('../storage/sweep');
    const store = openProgressStore(new IDBFactory());
    const now = Date.UTC(2026, 10, 10);
    const row = (key: string, updatedAt: number) => ({
      key,
      sessionId: 's',
      transferId: key,
      name: 'a',
      size: 1,
      blockSize: 4,
      bitmap: new Uint8Array([0]),
      staging: key,
      verified: true,
      updatedAt,
    });
    await store.put(row('old', now - 25 * 3600_000));
    await store.put(row('new', now - 3600_000));
    expect(await sweepStorage(store, now)).toBe(1);
    expect(await store.get('old')).toBeUndefined();
    expect(await store.get('new')).toBeDefined();
  });
});
