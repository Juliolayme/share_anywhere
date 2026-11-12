import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransfersApi } from './api';
import { Reporter } from './reporter';

describe('Reporter progress throttle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('progress arriving while a report is in flight waits for the next interval', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const api = {
      report: vi.fn(async (_id: string, status: string) => {
        await new Promise((r) => setTimeout(r, 250));
        sent.push(status);
        return { status };
      }),
    } as unknown as TransfersApi;
    const r = new Reporter(api, 10_000, () => Date.now());
    r.seed('t', 'TRANSFERRING', 0);
    r.progress('t', 1);
    await vi.advanceTimersByTimeAsync(100);
    r.progress('t', 2);
    r.progress('t', 3);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual(['TRANSFERRING']);
    r.dispose();
  });
});
