// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { fromHex } from '../../../lib/crypto/encoding';
import type { SessionSocket, SocketEvent } from '../../../lib/ws/socket';
import { StreamHasher } from '../engine/hash';
import { memorySink } from '../storage/memory';
import type { CloudApi, CloudObject } from './api';
import { newFileKey, sealPart, type ObjectKey } from './crypto';
import { CloudDownloadError, CloudReceive } from './receiver';

const PART = 1024;
const COUNT = 4;
const SIZE = PART * (COUNT - 1) + 300;

/** A READY object of SIZE bytes, its sealed parts, and a receiver that already holds its key. */
async function rig() {
  const plain = new Uint8Array(SIZE).map((_, i) => (i * 7 + 3) & 0xff);
  const key = newFileKey();
  const object = {
    id: 'obj-1',
    session_id: 's-1',
    file_id: 'file-1',
    status: 'READY',
    paused: false,
    size: SIZE,
    part_size: PART,
    part_count: COUNT,
  } as unknown as CloudObject;
  const parts: Uint8Array[] = [];
  for (let n = 0; n < COUNT; n++)
    parts.push(await sealPart(key, object.id, n, COUNT, plain.subarray(n * PART, Math.min(SIZE, (n + 1) * PART))));
  const h = new StreamHasher();
  h.update(0, plain);
  const ctl = { refuseFrom: COUNT, received: 0 };
  const api = {
    list: async () => [object],
    getPart: async (_: string, n: number) => {
      if (n >= ctl.refuseFrom) throw new ApiError(403, 'cloud_budget_exhausted', 'paused');
      const p = parts[n];
      if (!p) throw new ApiError(404, 'not_found', 'no part');
      return p;
    },
    received: async () => {
      ctl.received++;
      return object;
    },
  } as unknown as CloudApi;
  const socket = { subscribe: () => () => undefined, send: () => undefined } as unknown as SessionSocket;
  const c = new CloudReceive({
    sessionId: 's-1',
    participantId: 'p-r',
    senderPid: 'p-s',
    api,
    socket,
    onChange: () => {},
  });
  const inner = c as unknown as { objects: Map<string, CloudObject>; keys: Map<string, ObjectKey> };
  inner.objects.set(object.file_id, object);
  inner.keys.set(object.id, { objectId: object.id, fileId: object.file_id, key, sha256: fromHex(h.hex()) });
  return { c, plain, ctl };
}

async function bytesOf(sink: ReturnType<typeof memorySink>): Promise<Uint8Array> {
  return new Uint8Array(await sink.blob('application/octet-stream').arrayBuffer());
}

describe('CloudReceive resume (docs/TRANSFER_PROTOCOL.md §9)', () => {
  it('a download paused part way resumes at the next part in the same sink and delivers the exact file', async () => {
    const { c, plain, ctl } = await rig();
    const sink = memorySink(SIZE);
    const fetched: number[] = [];
    ctl.refuseFrom = 2;
    const write = (off: number, d: Uint8Array) => {
      fetched.push(off / PART);
      return sink.write(off, d);
    };
    await expect(
      c.download(
        'file-1',
        write,
        () => {},
        () => false,
      ),
    ).rejects.toEqual(new CloudDownloadError('paused'));
    expect(c.resumable('file-1')).toBe(true);
    ctl.refuseFrom = COUNT;
    await c.download(
      'file-1',
      write,
      () => {},
      () => false,
    );
    expect(fetched).toEqual([0, 1, 2, 3]);
    expect(await bytesOf(sink)).toEqual(plain);
    expect(ctl.received).toBe(1);
    expect(c.resumable('file-1')).toBe(false);
  });

  it('after restart a new, empty sink receives every part again (no zero-filled head that passes the hash)', async () => {
    const { c, plain, ctl } = await rig();
    ctl.refuseFrom = 2;
    const first = memorySink(SIZE);
    await expect(
      c.download(
        'file-1',
        (o, d) => first.write(o, d),
        () => {},
        () => false,
      ),
    ).rejects.toBeInstanceOf(CloudDownloadError);
    c.restart('file-1');
    expect(c.resumable('file-1')).toBe(false);
    ctl.refuseFrom = COUNT;
    const fresh = memorySink(SIZE);
    await c.download(
      'file-1',
      (o, d) => fresh.write(o, d),
      () => {},
      () => false,
    );
    expect(await bytesOf(fresh)).toEqual(plain);
  });

  it('a key request dropped while the socket was down is sent again on SOCKET_OPEN, without the 10 s wait', async () => {
    const object = {
      id: 'obj-2',
      session_id: 's-1',
      file_id: 'file-2',
      status: 'READY',
      paused: false,
      size: 10,
      part_size: PART,
      part_count: 1,
    } as unknown as CloudObject;
    let listener: ((e: SocketEvent) => void) | null = null;
    let connected = false;
    const sent: Array<Record<string, unknown>> = [];
    const socket = {
      subscribe: (l: (e: SocketEvent) => void) => {
        listener = l;
        return () => undefined;
      },
      send: (m: Record<string, unknown>) => {
        if (!connected) return false;
        sent.push(m);
        return true;
      },
    } as unknown as SessionSocket;
    const api = { list: async () => [object] } as unknown as CloudApi;
    const c = new CloudReceive({
      sessionId: 's-1',
      participantId: 'p-r',
      senderPid: 'p-s',
      api,
      socket,
      onChange: () => {},
    });
    await c.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    connected = true;
    (listener as ((e: SocketEvent) => void) | null)?.({ type: 'SOCKET_OPEN' } as SocketEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.map((m) => [m.type, m.to])).toEqual([['CLOUD_KEY_REQUEST', 'p-s']]);
  });
});
