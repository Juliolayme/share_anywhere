// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Bitmap } from './bitmap';
import { Throughput } from './eta';
import { blockCount, type FileMetaEntry } from './frame';
import { sha256Hex } from './hash';
import { ReceiverConnection, type PreparedFile } from './receiver';
import { FileHash, SenderConnection, type FileSource, type SenderFile } from './sender';
import { MemorySink, bytesOf, channelPair, until } from './testing';

const BS = 64 * 1024; // small blocks keep the tests fast while exercising many blocks
const SESSION = '5e55a000-0000-4000-8000-000000000001';
const PARTICIPANT = 'a11ce000-0000-4000-8000-000000000002';
const CAPABILITY = 'cap-abcdefghijklmnopqrstuvwxyz0123456789';

function source(bytes: Uint8Array, reads?: { n: number }): FileSource {
  return {
    size: bytes.byteLength,
    read: async (o, n) => {
      if (reads) reads.n++;
      return bytes.slice(o, o + n);
    },
  };
}

interface Files {
  data: Uint8Array[];
  files: SenderFile[];
  hashes: Map<number, FileHash>;
}

function files(sizes: number[]): Files {
  const data = sizes.map((s, i) => bytesOf(s, i + 11));
  const files = data.map((d, i) => ({
    index: i,
    fileId: `f${i}`,
    transferId: `t${i}`,
    name: `file-${i}.bin`,
    size: d.byteLength,
    mime: 'application/octet-stream',
    source: source(d),
  }));
  return { data, files, hashes: new Map(files.map((f) => [f.index, new FileHash(f.source)])) };
}

/** Receiver-side persistent state across connections (what IndexedDB + OPFS hold). */
class Disk {
  sinks = new Map<string, MemorySink>();
  bitmaps = new Map<string, Uint8Array>();
  verified = new Set<string>();
  prepare = async (e: FileMetaEntry): Promise<PreparedFile> => {
    const sink = this.sinks.get(e.transfer_id) ?? new MemorySink(e.size);
    this.sinks.set(e.transfer_id, sink);
    const saved = this.bitmaps.get(e.transfer_id);
    return {
      sink,
      bitmap: new Bitmap(e.block_count, saved),
      persist: async (b) => void this.bitmaps.set(e.transfer_id, b.bytes.slice()),
      verified: this.verified.has(e.transfer_id),
    };
  };
}

function connect(
  f: Files,
  disk: Disk,
  opts: { authorize?: boolean; corrupt?: number; maxMessageSize?: number; capability?: string } = {},
) {
  const [sch, rch] = channelPair(opts.maxMessageSize);
  const log: string[] = [];
  const sender = new SenderConnection({
    channel: sch,
    sessionId: SESSION,
    files: f.files,
    hashes: f.hashes,
    blockSize: BS,
    authorize: async (p, c) =>
      (opts.authorize ?? true) && p === PARTICIPANT && (await sha256Hex(c)) === (await sha256Hex(CAPABILITY)),
    corrupt: opts.corrupt ? { blocks: opts.corrupt } : undefined,
    events: {
      onComplete: () => log.push('sender:complete'),
      onError: (c, fatal) => log.push(`sender:error:${c}:${fatal}`),
      onPaused: (peer) => log.push(`sender:paused:${peer}`),
      onResumed: (peer) => log.push(`sender:resumed:${peer}`),
    },
  });
  const receiver = new ReceiverConnection({
    channel: rch,
    hello: {
      v: 1,
      role: 'receiver',
      session_id: SESSION,
      participant_id: PARTICIPANT,
      capability: opts.capability ?? CAPABILITY,
    },
    prepare: disk.prepare,
    events: {
      onComplete: () => log.push('receiver:complete'),
      onFileDone: (file, ok) => {
        log.push(`receiver:file:${file}:${ok}`);
        const id = f.files[file]?.transferId;
        if (ok && id) disk.verified.add(id);
      },
      onError: (c, fatal) => log.push(`receiver:error:${c}:${fatal}`),
      onPaused: (peer) => log.push(`receiver:paused:${peer}`),
      onResumed: (peer) => log.push(`receiver:resumed:${peer}`),
    },
  });
  receiver.start();
  return { sender, receiver, log, sch, rch };
}

const sinkOf = (d: Disk, id: string) => d.sinks.get(id)?.bytes ?? new Uint8Array(0);
const dataOf = (f: Files, i: number) => f.data[i] ?? new Uint8Array(0);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('transfer engine over an in-memory channel', () => {
  it('moves several files, including an empty one and a partial last block, with matching hashes', async () => {
    const f = files([BS * 5 + 123, 0, 1000]);
    const disk = new Disk();
    const c = connect(f, disk);
    await until(() => c.log.includes('receiver:complete') && c.log.includes('sender:complete'));
    f.data.forEach((d, i) => expect(sha(sinkOf(disk, `t${i}`))).toBe(sha(d)));
    expect(c.receiver.counters.duplicates).toBe(0);
    expect(c.sender.counters.blocksSent).toBe(6 + 0 + 1);
    expect(c.receiver.verifiedBytes(0)).toBe(BS * 5 + 123);
    expect(c.log.filter((l) => l.includes('error'))).toEqual([]);
  });

  it('respects a 16 KiB message limit (Safari-sized frames)', async () => {
    const f = files([BS * 2 + 5]);
    const disk = new Disk();
    const c = connect(f, disk, { maxMessageSize: 16 * 1024 });
    await until(() => c.log.includes('receiver:complete'));
    expect(sha(sinkOf(disk, 't0'))).toBe(sha(dataOf(f, 0)));
  });

  it('NACKs a corrupted block and re-sends it', async () => {
    const f = files([BS * 3]);
    const disk = new Disk();
    const c = connect(f, disk, { corrupt: 1 });
    await until(() => c.log.includes('receiver:complete'));
    expect(c.receiver.counters.nacksSent).toBe(1);
    expect(c.sender.counters.nacks).toBe(1);
    expect(c.sender.counters.blocksSent).toBe(4);
    expect(sha(sinkOf(disk, 't0'))).toBe(sha(dataOf(f, 0)));
  });

  it('gives up after repeated checksum failures', async () => {
    const f = files([BS]);
    const c = connect(f, new Disk(), { corrupt: 10 });
    await until(() => c.log.some((l) => l.startsWith('sender:error:checksum_retries')));
    expect(c.log).toContain('receiver:error:checksum_retries:true');
  });

  it('refuses a receiver whose capability does not match', async () => {
    const f = files([BS]);
    const c = connect(f, new Disk(), { capability: 'forged' });
    await until(() => c.log.includes('receiver:error:unauthorized:true'));
    expect(c.receiver.counters.blocksReceived).toBe(0);
  });

  it('resumes from the persisted bitmap after a reconnect with zero re-sent verified blocks', async () => {
    const f = files([BS * 40]);
    const disk = new Disk();
    const first = connect(f, disk);
    await until(() => (disk.bitmaps.get('t0') ? new Bitmap(40, disk.bitmaps.get('t0')).count >= 10 : false));
    first.rch.close(); // receiver tab reloads or the link drops
    await until(() => first.log.some((l) => l.startsWith('sender:error:closed')));
    const done = new Bitmap(40, disk.bitmaps.get('t0')).count;
    expect(done).toBeGreaterThanOrEqual(10);
    const second = connect(f, disk);
    await until(() => second.log.includes('receiver:complete'));
    expect(second.receiver.counters.duplicates).toBe(0);
    expect(second.sender.counters.verifiedResent).toBe(0);
    expect(second.sender.counters.blocksSent).toBe(40 - done);
    expect(sha(sinkOf(disk, 't0'))).toBe(sha(dataOf(f, 0)));
  });

  it('a reconnect after completion only re-confirms', async () => {
    const f = files([BS * 2]);
    const disk = new Disk();
    const first = connect(f, disk);
    await until(() => first.log.includes('receiver:complete'));
    const again = connect(f, disk);
    await until(() => again.log.includes('receiver:complete'));
    expect(again.sender.counters.blocksSent).toBe(0);
  });

  it('pauses and resumes from either side', async () => {
    const f = files([BS * 30]);
    const disk = new Disk();
    const c = connect(f, disk);
    await until(() => c.receiver.verifiedBytes(0) > 0);
    c.receiver.pause();
    await until(() => c.log.includes('sender:paused:true'));
    await new Promise((r) => setTimeout(r, 20));
    const frozen = c.sender.counters.blocksSent;
    await new Promise((r) => setTimeout(r, 30));
    expect(c.sender.counters.blocksSent).toBe(frozen); // nothing new while paused
    c.receiver.resume();
    await until(() => c.log.includes('sender:resumed:true'));
    c.sender.pause();
    await until(() => c.log.includes('receiver:paused:true'));
    c.sender.resume();
    await until(() => c.log.includes('receiver:complete'));
    expect(c.receiver.counters.duplicates).toBe(0);
  });

  it('cancel ends both sides', async () => {
    const f = files([BS * 30]);
    const c = connect(f, new Disk());
    await until(() => c.receiver.verifiedBytes(0) > 0);
    c.sender.cancel();
    await until(() => c.log.includes('receiver:error:cancelled:true'));
  });

  it('reads each block once in order and hashes the whole file without a second pass', async () => {
    const reads = { n: 0 };
    const data = bytesOf(BS * 8, 4);
    const src = source(data, reads);
    const f: Files = {
      data: [data],
      files: [{ index: 0, fileId: 'f0', transferId: 't0', name: 'a', size: data.byteLength, mime: '', source: src }],
      hashes: new Map([[0, new FileHash(src)]]),
    };
    const disk = new Disk();
    const c = connect(f, disk);
    await until(() => c.log.includes('receiver:complete'));
    expect(reads.n).toBe(blockCount(data.byteLength, BS));
  });
});

describe('Throughput', () => {
  it('stays provisional until 3 % and while reconnecting, then estimates from the EWMA', () => {
    const t = new Throughput(0.5, 0);
    t.sample(0, 0);
    t.sample(1_000_000, 1000);
    expect(t.estimate(1_000_000, 100_000_000).seconds).toBeNull(); // 1 %
    t.sample(5_000_000, 2000);
    const e = t.estimate(5_000_000, 100_000_000);
    expect(e.bytesPerSecond).toBe(0.5 * 4_000_000 + 0.5 * 1_000_000);
    expect(e.seconds).toBe(Math.ceil(95_000_000 / 2_500_000));
    expect(t.estimate(5_000_000, 100_000_000, true).seconds).toBeNull();
  });

  it('goes back to provisional when nothing arrives for 10 s instead of showing a huge ETA', () => {
    const t = new Throughput(0.5, 0);
    t.sample(0, 0);
    t.sample(10_000_000, 1000);
    expect(t.estimate(10_000_000, 100_000_000).seconds).not.toBeNull();
    for (let ms = 2000; ms <= 12_000; ms += 1000) t.sample(10_000_000, ms); // stalled
    const e = t.estimate(10_000_000, 100_000_000);
    expect(e.seconds).toBeNull();
    expect(e.bytesPerSecond).toBe(0);
    t.sample(12_000_000, 13_000); // bytes again
    expect(t.estimate(12_000_000, 100_000_000).seconds).not.toBeNull();
  });
});

describe('ReceiverConnection.mute', () => {
  it('sends nothing once muted (the page is going away)', () => {
    const [a] = channelPair();
    const rx = new ReceiverConnection({
      channel: a,
      hello: { v: 1, role: 'receiver', session_id: 's', participant_id: 'p', capability: 'c' },
      prepare: async () => {
        throw new Error('not used');
      },
    });
    rx.start();
    const sent = a.sent;
    expect(sent).toBeGreaterThan(0); // HELLO went out
    rx.mute();
    rx.pause();
    rx.resume();
    rx.cancel();
    expect(a.sent).toBe(sent);
  });
});
