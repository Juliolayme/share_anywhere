import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSocket } from '../../../lib/ws/socket';
import type { SessionView } from '../../sharing/api';
import type { ProgressStore } from '../storage/progress-store';
import type { Transfer, TransferStatus, TransfersApi } from './api';
import { ReceiverController } from './receiver-controller';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** A fake server that applies the real report rule: leaving PAUSED for an active state needs the resume action. */
function setup(initial: TransferStatus) {
  let server: TransferStatus = initial;
  const reports: TransferStatus[] = [];
  const actions: string[] = [];
  const transfer = (): Transfer => ({ id: 't1', status: server, verified_bytes: 0 }) as unknown as Transfer;
  const api = {
    list: async () => ({
      role: 'receiver',
      capability: 'cap',
      transfers: [{ ...transfer(), file_id: 'f1', size: 10 }],
    }),
    report: async (_id: string, status: TransferStatus) => {
      if (server === 'PAUSED' && status !== 'PAUSED' && !TERMINAL.includes(status)) throw new Error('use_resume');
      reports.push(status);
      server = status;
      return transfer();
    },
    action: async (_id: string, a: string, capability?: string) => {
      actions.push(capability ? `${a}:${capability}` : a);
      if (a === 'pause') server = 'PAUSED';
      if (a === 'resume') server = 'RESUMING';
      return transfer();
    },
    turn: async () => {
      throw new Error('no TURN in this test');
    },
  } as unknown as TransfersApi;
  let dials = 0;
  const peer = {
    connectionState: 'new',
    createDataChannel: () => ({}),
    createOffer: async () => ({ type: 'offer', sdp: '' }),
    setLocalDescription: async () => undefined,
    localDescription: { toJSON: () => ({ type: 'offer', sdp: '' }) },
    close: () => undefined,
    addEventListener: () => undefined,
  } as unknown as RTCPeerConnection;
  const view = {
    sender: { participant_id: 'snd', display_name: 'S' },
    me: { id: 'me', security_words: [] },
    files: [{ id: 'f1', name: 'a', size: 10, mime: 'x' }],
  } as unknown as SessionView;
  const store = {
    get: async () => undefined,
    getTarget: async () => ({ sessionId: 's1', mode: 'opfs' }),
    put: async () => undefined,
    putTarget: async () => undefined,
    remove: async () => undefined,
    removeSession: async () => undefined,
  } as unknown as ProgressStore;
  const rx = new ReceiverController({
    sessionId: 's1',
    api,
    view: async () => view,
    socket: { subscribe: () => () => undefined, send: () => true } as unknown as SessionSocket,
    store,
    history: null,
    createPeer: () => {
      dials++;
      return peer;
    },
  });
  return {
    rx,
    reports,
    actions,
    dials: () => dials,
    server: () => server,
    setServer: (v: TransferStatus) => (server = v),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ReceiverController', () => {
  it('after a reload mid-transfer it reconnects without ever reporting PAUSED', async () => {
    vi.useFakeTimers();
    const t = setup('TRANSFERRING');
    await t.rx.init();
    await vi.advanceTimersByTimeAsync(50);
    expect(t.rx.state.phase).toBe('connecting');
    expect(t.reports).toEqual(['DISCONNECTED', 'CONNECTING']);
    expect(t.server()).toBe('CONNECTING');
    t.rx.dispose();
  });

  it('Pause pressed while reconnecting holds: no new dials until Resume, which uses the capability', async () => {
    vi.useFakeTimers();
    const t = setup('TRANSFERRING');
    await t.rx.init();
    await vi.advanceTimersByTimeAsync(20_500); // the channel never opens: lost, reconnecting, retry pending
    expect(t.rx.state.phase).toBe('reconnecting');
    t.rx.pause();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.rx.state.phase).toBe('paused');
    expect(t.server()).toBe('PAUSED');
    const before = t.dials();
    await vi.advanceTimersByTimeAsync(30_000); // the old retry timer and any backoff would have fired by now
    expect(t.rx.state.phase).toBe('paused');
    expect(t.dials()).toBe(before);
    expect(t.server()).toBe('PAUSED');

    await t.rx.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.actions).toContain('resume:cap');
    expect(t.dials()).toBe(before + 1);
    expect(['connecting', 'reconnecting']).toContain(t.rx.state.phase);
    expect(t.server()).not.toBe('PAUSED');
    t.rx.dispose();
  });

  it('a report that finds the server PAUSED without a local pause resumes it first', async () => {
    vi.useFakeTimers();
    const t = setup('TRANSFERRING');
    await t.rx.init();
    await vi.advanceTimersByTimeAsync(20_500); // reconnecting, retry pending
    expect(t.rx.state.phase).toBe('reconnecting');
    // The server record is PAUSED although nobody paused here (an older client left it so).
    t.setServer('PAUSED');
    (t.rx as unknown as { reporter: { seed(id: string, s: TransferStatus, v: number): void } }).reporter.seed(
      't1',
      'PAUSED',
      0,
    );
    await vi.advanceTimersByTimeAsync(2_000); // the retry dials and reports RECONNECTING
    expect(t.actions).toContain('resume:cap');
    expect(t.server()).toBe('RECONNECTING');
    t.rx.dispose();
  });
});
