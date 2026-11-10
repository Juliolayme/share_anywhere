import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSocket, SocketEvent } from '../../../lib/ws/socket';
import type { SessionView } from '../../sharing/api';
import type { TransferStatus, TransfersApi } from './api';
import { Throughput } from '../engine/eta';
import { SenderController } from './sender-controller';

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
    const t = setup('TRANSFERRING', () => pc);
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
    t.emit(cand(1));
    t.emit(cand(2));
    await vi.waitFor(() => expect(added).toHaveLength(2));
    t.emit(cand(3)); // after the remote description: added directly
    await vi.waitFor(() => expect(added).toHaveLength(3));
    t.tx.dispose();
  });
});
