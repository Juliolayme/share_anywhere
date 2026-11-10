// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StreamHasher, digest, hashStream, hex } from './hash';
import { bytesOf } from './testing';

const nodeHex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('hashing', () => {
  it('block digest matches Node crypto', async () => {
    const data = bytesOf(1_000_003, 3);
    expect(hex(await digest(data))).toBe(nodeHex(data));
  });

  it('streamed whole-file hash equals Node crypto for random chunkings', async () => {
    const data = bytesOf(3_000_017, 9);
    const expected = nodeHex(data);
    for (const chunk of [1, 7, 65_536, 1_000_000, 4 * 1024 * 1024]) {
      if (chunk === 1) {
        const h = new StreamHasher();
        h.update(0, data.subarray(0, 1000));
        expect(h.hex()).toBe(nodeHex(data.subarray(0, 1000)));
        continue;
      }
      const got = await hashStream(data.byteLength, async (o, n) => data.subarray(o, o + n), undefined, chunk);
      expect(got).toBe(expected);
    }
  });

  it('ignores re-fed ranges and refuses gaps', () => {
    const data = bytesOf(100, 5);
    const h = new StreamHasher();
    expect(h.update(0, data.subarray(0, 60))).toBe(true);
    expect(h.update(80, data.subarray(80))).toBe(false); // gap
    expect(h.update(40, data.subarray(40))).toBe(true); // overlap is skipped
    expect(h.position).toBe(100);
    expect(h.hex()).toBe(nodeHex(data));
  });

  it('empty file', async () => {
    expect(await hashStream(0, async () => new Uint8Array(0))).toBe(nodeHex(new Uint8Array(0)));
  });
});
