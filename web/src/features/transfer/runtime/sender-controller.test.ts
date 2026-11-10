import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSocket, SocketEvent } from '../../../lib/ws/socket';
import type { SessionView } from '../../sharing/api';
import type { TransferStatus, TransfersApi } from './api';
import { Throughput } from '../engine/eta';
import type { HistoryStore } from '../../history/store/history-store';
import {
  SenderController,
  finalOf,
  groupEta,
  resultOf,
  routeOf,
  sanitizeCandidate,
  type TxStatus,
} from './sender-controller';

/** A sender tab with one joined receiver and one file, no picked files (so no peer connection is served). */
function setup(status: TransferStatus, createPeer?: (cfg: RTCConfiguration) => RTCPeerConnection) {
  let listCalls = 0;
  let emit: (e: SocketEvent) => void = () => undefined;
  const transfer = (s: TransferStatus) => ({
    id: 't1',
    participant_id: 'p1',
    file_id: 'f1',
    status: s,
    verified_bytes: 5,
  });
  const api = {
    list: async () => {
      listCalls++;
      return { role: 'sender', transfers: [transfer(status)], peers: [] };
    },
    action: async () => transfer(status),
    report: async () => transfer(status),
    turn: async () => {
      throw new Error('no TURN in this test');
    },
  } as unknown as TransfersApi;
  const view = {
    id: 's1',
    files: [{ id: 'f1', name: 'a.bin', size: 10, mime: 'application/octet-stream' }],
    participants: [{ id: 'p1', role: 'receiver', status: 'JOINED', display_name: 'R', platform: 'Web' }],
    join_window: { state: 'CLOSED' },
    server_time: new Date().toISOString(),
  } as unknown as SessionView;
  const socket = {
    subscribe: (fn: (e: SocketEvent) => void) => {
      emit = fn;
      return () => undefined;
    },
    send: () => true,
  } as unknown as SessionSocket;
  const tx = new SenderController({
    sessionId: 's1',
    api,
    view: async () => view,
    socket,
    history: null,
    files: undefined,
    ...(createPeer ? { createPeer } : {}),
  });
  const card = () => tx.state.receivers[0]?.status;
  const updated = (s: TransferStatus) =>
    emit({ type: 'TRANSFER_UPDATED', transfer: transfer(s) } as unknown as SocketEvent);
  return { tx, card, updated, emit: (e: SocketEvent) => emit(e), listCalls: () => listCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SenderController', () => {
  it('leaves Paused when the receiver resumes through the server, then goes Offline after the reconnect window', async () => {
    vi.useFakeTimers();
    const t = setup('PAUSED');
    await t.tx.init();
    expect(t.card()).toBe('paused');
    t.updated('RESUMING'); // the receiver resumed (no channel open yet on this side)
    expect(t.card()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(t.card()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(t.card()).toBe('offline');
    t.tx.dispose();
  });

  it('a sender Resume with the receiver away also starts the window', async () => {
    vi.useFakeTimers();
    const t = setup('PAUSED');
    await t.tx.init();
    t.tx.resume('p1');
    expect(t.card()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    expect(t.card()).toBe('offline');
    t.tx.dispose();
  });

  it('reloads the transfer records when the socket reconnects (events may have been missed)', async () => {
    const t = setup('TRANSFERRING');
    await t.tx.init();
    const before = t.listCalls();
    t.emit({ type: 'SOCKET_OPEN' } as unknown as SocketEvent);
    await vi.waitFor(() => expect(t.listCalls()).toBe(before + 1));
    t.tx.dispose();
  });
  it('a receiver that left while paused: Resume shows reconnecting (not transferring) and the window runs', async () => {
    vi.useFakeTimers();
    const t = setup('PAUSED');
    await t.tx.init();
    let closed = 0;
    const internals = t.tx as unknown as {
      peers: Map<string, unknown>;
      onLost(pid: string): void;
    };
    // The peer connection failed while the card was paused (Chromium can leave the data channel "open").
    internals.peers.set('p1', {
      pc: { connectionState: 'failed', close: () => undefined },
      conn: { close: () => closed++, resume: () => undefined, pause: () => undefined },
      connId: 'c1',
      throughput: new Throughput(),
    });
    internals.onLost('p1');
    expect(closed).toBe(1);
    expect(t.card()).toBe('paused');
    t.tx.resume('p1');
    expect(t.card()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    expect(t.card()).toBe('offline');
    t.tx.dispose();
  });
  it('keeps receiver candidates that arrive before the offer is set up, and adds them after the remote description', async () => {
    const added: string[] = [];
    let remoteSet = false;
    const pc = {
      connectionState: 'new',
      setRemoteDescription: async () => {
        await new Promise((r) => setTimeout(r, 20));
        remoteSet = true;
      },
      createAnswer: async () => ({ type: 'answer', sdp: '' }),
      setLocalDescription: async () => undefined,
      localDescription: { toJSON: () => ({ type: 'answer', sdp: '' }) },
      addIceCandidate: async (c: RTCIceCandidateInit) => {
        if (!remoteSet) throw new Error('no remote description');
        added.push(c.candidate ?? '');
      },
      addEventListener: () => undefined,
      close: () => undefined,
    } as unknown as RTCPeerConnection;
    let afterPeer: () => void = () => undefined;
    const t = setup('TRANSFERRING', () => {
      queueMicrotask(() => afterPeer()); // peer registered, remote description still pending
      return pc;
    });
    await t.tx.init();
    const cand = (n: number) =>
      ({
        type: 'ICE_CANDIDATE',
        from: 'p1',
        payload: { conn: 'c1', candidate: { candidate: `candidate:${n} 1 udp 1 10.0.0.${n} 5000 typ host` } },
      }) as unknown as SocketEvent;
    // The receiver trickles host candidates right after its offer, before the sender has set anything up.
    t.emit({
      type: 'OFFER',
      from: 'p1',
      payload: { conn: 'c1', sdp: { type: 'offer', sdp: '' } },
    } as unknown as SocketEvent);
    afterPeer = () => t.emit(cand(3)); // arrives after the peer exists but before the remote description
    t.emit(cand(1));
    t.emit(cand(2));
    await vi.waitFor(() => expect(added).toHaveLength(3));
    expect(added.map((c) => c.split(' ')[0])).toEqual(['candidate:1', 'candidate:2', 'candidate:3']);
    t.emit(cand(4)); // after the remote description: added directly
    await vi.waitFor(() => expect(added).toHaveLength(4));
    // Oversized candidates are ignored.
    t.emit({
      type: 'ICE_CANDIDATE',
      from: 'p1',
      payload: { conn: 'c1', candidate: { candidate: 'x'.repeat(2000) } },
    } as unknown as SocketEvent);
    await new Promise((r) => setTimeout(r, 30));
    expect(added).toHaveLength(4);
    t.tx.dispose();
  });
  it('holds early candidates per receiver and connection: stale connections never leak, caps apply', async () => {
    const added: string[] = [];
    let remoteSet = false;
    const pc = {
      connectionState: 'new',
      setRemoteDescription: async () => {
        remoteSet = true;
      },
      createAnswer: async () => ({ type: 'answer', sdp: '' }),
      setLocalDescription: async () => undefined,
      localDescription: { toJSON: () => ({ type: 'answer', sdp: '' }) },
      addIceCandidate: async (c: RTCIceCandidateInit) => {
        if (!remoteSet) throw new Error('no remote description');
        added.push(c.candidate ?? '');
      },
      addEventListener: () => undefined,
      close: () => undefined,
    } as unknown as RTCPeerConnection;
    const t = setup('TRANSFERRING', () => pc);
    await t.tx.init();
    const cand = (conn: string, n: number) =>
      ({
        type: 'ICE_CANDIDATE',
        from: 'p1',
        payload: { conn, candidate: { candidate: `candidate:${n} 1 udp 1 10.0.0.1 ${5000 + n} typ host` } },
      }) as unknown as SocketEvent;
    for (let n = 0; n < 3; n++) t.emit(cand('c0', n)); // an abandoned connection
    for (let n = 0; n < 60; n++) t.emit(cand('c1', n)); // capped at 50
    t.emit({
      type: 'OFFER',
      from: 'p1',
      payload: { conn: 'c1', sdp: { type: 'offer', sdp: '' } },
    } as unknown as SocketEvent);
    await vi.waitFor(() => expect(added).toHaveLength(50));
    expect(added[0]).toContain('candidate:0 ');
    expect(added.at(-1)).toContain('candidate:49 ');
    // The abandoned connection's candidates were never flushed into c1's peer connection.
    expect(added.filter((c) => c.endsWith('5000 typ host'))).toHaveLength(1);
    t.tx.dispose();
  });

  it('keeps only the known, well-formed fields of a relayed candidate', () => {
    expect(
      sanitizeCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host', sdpMid: '0', extra: 'x'.repeat(9000) }),
    ).toEqual({
      candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host',
      sdpMid: '0',
    });
    expect(sanitizeCandidate({ candidate: 'x'.repeat(2000) })).toBeNull();
    expect(sanitizeCandidate({ candidate: 42 })).toBeNull();
    expect(sanitizeCandidate(null)).toBeNull();
  });
  it('group ETA follows the slowest active receiver and estimates while one has no ETA yet', () => {
    expect(groupEta([])).toBeUndefined();
    expect(groupEta([{ status: 'completed', eta: null }])).toBeUndefined();
    expect(
      groupEta([
        { status: 'transferring', eta: 30 },
        { status: 'transferring', eta: 90 },
      ]),
    ).toBe(90);
    expect(
      groupEta([
        { status: 'transferring', eta: 30 },
        { status: 'paused', eta: 500 },
      ]),
    ).toBe(30);
    expect(
      groupEta([
        { status: 'transferring', eta: 30 },
        { status: 'reconnecting', eta: null },
      ]),
    ).toBeNull();
  });
  it('History route: one route for every receiver, mixed otherwise, nothing when unknown', () => {
    expect(routeOf([])).toEqual({});
    expect(routeOf([null, null])).toEqual({});
    expect(routeOf(['direct', null, 'direct'])).toEqual({ route: 'direct' });
    expect(routeOf(['direct', 'relay'])).toEqual({ route: 'mixed' });
  });
  it('session result: removed and blocked receivers do not count unless delivered; one that left counts', () => {
    const r = (status: TxStatus, delivered = status === 'completed') => ({ status, delivered });
    expect(finalOf([r('completed'), r('removed')])).toBe('completed');
    expect(finalOf([r('completed'), r('blocked'), r('removed')])).toBe('completed');
    expect(finalOf([r('completed'), r('cancelled')])).toBe('partial'); // left early, or cancelled
    expect(finalOf([r('completed'), r('failed')])).toBe('partial');
    expect(finalOf([r('failed'), r('cancelled')])).toBe('failed');
    expect(finalOf([r('cancelled'), r('removed')])).toBe('cancelled');
    // Blocked after receiving every file: still a delivery.
    expect(finalOf([r('blocked', true)])).toBe('completed');
    expect(finalOf([r('blocked', true), r('failed')])).toBe('partial');
  });
  it('the result is provisional while the session is live: none until someone counts, cleared by a late receiver', () => {
    const r = (status: TxStatus, delivered = status === 'completed') => ({ status, delivered });
    expect(resultOf([], false)).toBeNull();
    expect(resultOf([r('removed')], false)).toBeNull(); // the only receiver was a stranger the sender removed
    expect(resultOf([r('completed')], false)).toBe('completed');
    expect(resultOf([r('completed'), r('transferring')], false)).toBeNull(); // a late receiver joined
    expect(resultOf([r('completed'), r('waiting')], false)).toBeNull();
    expect(resultOf([r('completed'), r('failed')], false)).toBe('partial');
    // Once the session has ended the result is final, whatever was still going.
    expect(resultOf([r('completed'), r('cancelled')], true)).toBe('partial');
    expect(resultOf([r('removed')], true)).toBe('cancelled');
  });
  it('a late receiver after the result: the result clears, then History is rewritten with both receivers', async () => {
    const transfers = [{ id: 't1', participant_id: 'p1', file_id: 'f1', status: 'COMPLETED', verified_bytes: 10 }];
    const participants = [{ id: 'p1', role: 'receiver', status: 'JOINED', display_name: 'A', platform: 'Web' }];
    const writes: { id: string; status: string; peers?: string[]; createdAt: number }[] = [];
    const api = {
      list: async () => ({ role: 'sender', transfers: transfers.map((x) => ({ ...x })), peers: [] }),
      action: async () => transfers[0],
      report: async () => transfers[0],
      turn: async () => {
        throw new Error('no TURN in this test');
      },
    } as unknown as TransfersApi;
    const view = async () =>
      ({
        id: 's1',
        status: 'ACTIVE',
        files: [{ id: 'f1', name: 'a.bin', size: 10, mime: 'application/octet-stream' }],
        participants: participants.map((x) => ({ ...x })),
        join_window: { state: 'OPEN', ends_at: new Date(Date.now() + 60_000).toISOString() },
        server_time: new Date().toISOString(),
      }) as unknown as SessionView;
    const tx = new SenderController({
      sessionId: 's1',
      api,
      view,
      socket: { subscribe: () => () => undefined, send: () => true } as unknown as SessionSocket,
      history: { add: async (e: (typeof writes)[number]) => void writes.push(e) } as unknown as HistoryStore,
      files: undefined,
    });
    await tx.init();
    expect(tx.state.final).toBe('completed');
    expect(writes.map((w) => [w.status, w.peers])).toEqual([['completed', ['A']]]);

    participants.push({ id: 'p2', role: 'receiver', status: 'JOINED', display_name: 'B', platform: 'Web' });
    transfers.push({ id: 't2', participant_id: 'p2', file_id: 'f1', status: 'TRANSFERRING', verified_bytes: 4 });
    await tx.refresh();
    expect(tx.state.final).toBeNull();
    expect(writes).toHaveLength(1);

    (transfers[1] as { status: string }).status = 'FAILED';
    await tx.refresh();
    expect(tx.state.final).toBe('partial');
    expect(writes.map((w) => [w.status, w.peers])).toEqual([
      ['completed', ['A']],
      ['partial', ['A', 'B']],
    ]);
    expect(new Set(writes.map((w) => w.id)).size).toBe(1); // the same entry, rewritten
    expect(writes[1]?.createdAt).toBe(writes[0]?.createdAt);
    await tx.refresh(); // nothing changed: no rewrite
    expect(writes).toHaveLength(2);
    tx.dispose();
  });
  it('when the session ends mid-transfer, receivers still going show cancelled and the result is final', async () => {
    const t = setup('TRANSFERRING');
    await t.tx.init();
    expect(t.card()).toBe('reconnecting');
    t.emit({ type: 'SESSION_EXPIRED', reason: 'max_lifetime' } as unknown as SocketEvent);
    expect(t.card()).toBe('cancelled');
    expect(t.tx.state.ended).toBe(true);
    expect(t.tx.state.final).toBe('cancelled');
    t.tx.dispose();
  });
  it('a blocked receiver is shown as blocked and left out of the result; a removed one as removed', async () => {
    const t = setup('CANCELLED');
    const internals = t.tx as unknown as { d: { view: () => Promise<SessionView> } };
    const base = await internals.d.view();
    for (const [status, card] of [
      ['BLOCKED', 'blocked'],
      ['REMOVED', 'removed'],
      ['LEFT', 'cancelled'],
    ] as const) {
      await t.tx.refresh({
        ...base,
        participants: [{ id: 'p1', role: 'receiver', status, display_name: 'R', platform: 'Web' }],
      } as unknown as SessionView);
      expect(t.card()).toBe(card);
      expect(t.tx.state.receivers[0]?.joined).toBe(false);
    }
    t.tx.dispose();
  });
});
