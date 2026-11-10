import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Bitmap } from './bitmap';
import { BlockCache, blockCacheBytes } from './cache';
import type { FileMetaEntry } from './frame';
import { ReceiverConnection, type PreparedFile } from './receiver';
import { FileHash, SenderConnection, type FileSource, type SenderFile } from './sender';
import { MemorySink, bytesOf, channelPair, until } from './testing';

const BS = 16 * 1024;
const SESSION = '5e55a000-0000-4000-8000-000000000001';

describe('BlockCache', () => {
  it('never holds more than its budget and evicts the least recently used block first', async () => {
    const cache = new BlockCache(3 * BS);
    const load = (n: number) => async () => bytesOf(BS, n + 1);
    for (let b = 0; b < 3; b++) await cache.get(0, b, load(b));
    expect(cache.bytes).toBe(3 * BS);
    await cache.get(0, 0, load(0)); // touch block 0: block 1 is now the oldest
    await cache.get(0, 3, load(3));
    expect(cache.bytes).toBeLessThanOrEqual(3 * BS);
    expect(cache.stats.evictions).toBe(1);
    const reads = cache.stats.reads;
    await cache.get(0, 0, load(0)); // still cached
    expect(cache.stats.reads).toBe(reads);
    await cache.get(0, 1, load(1)); // was evicted: read again
    expect(cache.stats.reads).toBe(reads + 1);
  });

  it('shares one read between concurrent requests for the same block, and hashes it once', async () => {
    const cache = new BlockCache(10 * BS);
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return bytesOf(BS, 7);
    };
    const [a, b] = await Promise.all([cache.get(0, 0, load), cache.get(0, 0, load)]);
    expect(loads).toBe(1);
    expect(a).toBe(b);
    expect(Buffer.from(a.sum).toString('hex')).toBe(createHash('sha256').update(a.data).digest('hex'));
  });

  it('serves a block larger than the whole budget without caching it', async () => {
    const cache = new BlockCache(BS / 2);
    await cache.get(0, 0, async () => bytesOf(BS, 1));
    expect(cache.bytes).toBe(0);
  });
});

/** A sender ↔ receiver pair sharing `cache`; `writeDelayMs` slows the receiver's disk (a slow receiver). */
function pair(file: SenderFile, hashes: Map<number, FileHash>, cache: BlockCache | undefined, writeDelayMs = 0) {
  const [sch, rch] = channelPair();
  const sink = new MemorySink(file.size);
  let verified = 0;
  let done = false;
  new SenderConnection({
    channel: sch,
    sessionId: SESSION,
    files: [file],
    hashes,
    cache,
    blockSize: BS,
    authorize: async () => true,
  });
  const receiver = new ReceiverConnection({
    channel: rch,
    hello: { v: 1, role: 'receiver', session_id: SESSION, participant_id: 'p', capability: 'c' },
    prepare: async (e: FileMetaEntry): Promise<PreparedFile> => ({
      sink: {
        ...sink,
        write: async (o, d) => {
          if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
          await sink.write(o, d);
        },
        read: (o, n) => sink.read(o, n),
        flush: async () => undefined,
      },
      bitmap: new Bitmap(e.block_count),
      persist: async () => undefined,
      verified: false,
    }),
    events: {
      onProgress: (_f, bytes) => (verified = bytes),
      onComplete: () => (done = true),
    },
  });
  receiver.start();
  return { sink, verified: () => verified, done: () => done };
}

function fileOf(size: number, reads: { n: number }): { file: SenderFile; data: Uint8Array } {
  const data = bytesOf(size, 3);
  const source: FileSource = {
    size,
    read: async (o, n) => {
      reads.n++;
      return data.slice(o, o + n);
    },
  };
  const file = { index: 0, fileId: 'f', transferId: 't', name: 'f.bin', size, mime: 'x', source };
  return { file, data };
}

describe('multi-receiver scheduling', () => {
  it('a slow receiver does not hold back a fast one', async () => {
    const reads = { n: 0 };
    const { file, data } = fileOf(64 * BS, reads);
    const hashes = new Map([[0, new FileHash(file.source)]]);
    const cache = new BlockCache(8 * BS);
    const slow = pair(file, hashes, cache, 40); // 40 ms per block write
    const fast = pair(file, hashes, cache);
    await until(fast.done, 20_000);
    // When the fast receiver has everything, the slow one is far behind: its pace did not limit the other.
    expect(slow.verified()).toBeLessThan(file.size / 2);
    expect(fast.sink.bytes).toEqual(data);
    await until(slow.done, 30_000);
    expect(slow.sink.bytes).toEqual(data);
  }, 40_000);

  it('receivers moving together read the file once through the shared cache', async () => {
    const reads = { n: 0 };
    const { file, data } = fileOf(32 * BS, reads);
    const hashes = new Map([[0, new FileHash(file.source)]]);
    const cache = new BlockCache(64 * BS);
    const receivers = [0, 1, 2].map(() => pair(file, hashes, cache));
    await until(() => receivers.every((r) => r.done()), 20_000);
    for (const r of receivers) expect(r.sink.bytes).toEqual(data);
    expect(cache.stats.reads).toBe(32); // one read per block for three receivers
    expect(reads.n).toBe(32); // and the whole-file hash needed no second pass
  });

  it('without a cache every receiver reads every block itself', async () => {
    const reads = { n: 0 };
    const { file } = fileOf(16 * BS, reads);
    const hashes = new Map([[0, new FileHash(file.source)]]);
    const receivers = [0, 1].map(() => pair(file, hashes, undefined));
    await until(() => receivers.every((r) => r.done()), 20_000);
    expect(reads.n).toBe(32);
  });
});

describe('block cache budget setting', () => {
  it('defaults to 64 MiB and never drops below one block', () => {
    const MiB = 1024 * 1024;
    expect(blockCacheBytes(undefined)).toBe(64 * MiB);
    expect(blockCacheBytes('')).toBe(64 * MiB);
    expect(blockCacheBytes('abc')).toBe(64 * MiB);
    expect(blockCacheBytes('-5')).toBe(64 * MiB);
    expect(blockCacheBytes('128')).toBe(128 * MiB);
    expect(blockCacheBytes('1')).toBe(4 * MiB);
    expect(blockCacheBytes('0.5')).toBe(4 * MiB);
  });
});
