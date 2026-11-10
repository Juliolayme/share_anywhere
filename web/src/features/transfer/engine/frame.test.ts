import { describe, expect, it } from 'vitest';
import {
  FLAG_FIRST,
  FLAG_LAST,
  FrameType,
  HEADER_BYTES,
  NO_FILE,
  ProtocolError,
  blockCount,
  blockLength,
  dataPerFrame,
  decodeFrame,
  encodeFrame,
  jsonFrame,
  readJson,
} from './frame';
import { bytesOf } from './testing';

describe('frame codec', () => {
  it('round-trips every frame type', () => {
    const payload = bytesOf(100, 7);
    const block = decodeFrame(
      encodeFrame({ type: FrameType.BLOCK, flags: FLAG_FIRST | FLAG_LAST, file: 2, block: 9, offset: 0, payload }),
    );
    expect(block).toMatchObject({ type: FrameType.BLOCK, flags: 3, file: 2, block: 9, offset: 0 });
    expect([...block.payload]).toEqual([...payload]);
    const ack = decodeFrame(encodeFrame({ type: FrameType.ACK, file: 1, block: 4 }));
    expect(ack).toMatchObject({ type: FrameType.ACK, file: 1, block: 4, offset: 0, flags: 0 });
    expect(ack.payload.byteLength).toBe(0);
    const hello = decodeFrame(jsonFrame(FrameType.HELLO, { v: 1, role: 'sender', session_id: 's' }));
    expect(hello.file).toBe(NO_FILE);
    expect(readJson(hello)).toEqual({ v: 1, role: 'sender', session_id: 's' });
  });

  it('writes the header big-endian at fixed offsets', () => {
    const buf = new Uint8Array(encodeFrame({ type: FrameType.ACK, file: 0x01020304, block: 0x0a0b0c0d }));
    expect([...buf]).toEqual([1, 5, 0, 0, 1, 2, 3, 4, 10, 11, 12, 13, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('rejects malformed frames', () => {
    const good = new Uint8Array(encodeFrame({ type: FrameType.BLOCK, flags: FLAG_FIRST, payload: bytesOf(40) }));
    expect(() => decodeFrame(good.slice(0, 10))).toThrow(ProtocolError);
    const v2 = good.slice();
    v2[0] = 2;
    expect(() => decodeFrame(v2)).toThrow(/version/);
    const unknown = good.slice();
    unknown[1] = 99;
    expect(() => decodeFrame(unknown)).toThrow(/type/);
    expect(() => decodeFrame(good.slice(0, good.length - 1))).toThrow(/length/);
    expect(() => decodeFrame(encodeFrame({ type: FrameType.BLOCK, flags: FLAG_FIRST, payload: bytesOf(10) }))).toThrow(
      /digest/,
    );
    expect(() => decodeFrame(encodeFrame({ type: FrameType.PAUSE, payload: bytesOf(1) }))).toThrow(/payload/);
    expect(() =>
      readJson(decodeFrame(encodeFrame({ type: FrameType.ERROR, payload: new Uint8Array([0xff, 0xfe]) }))),
    ).toThrow(/JSON/);
    expect(() => encodeFrame({ type: FrameType.ACK, block: -1 })).toThrow(ProtocolError);
    expect(() => jsonFrame(FrameType.BLOCK, {})).toThrow(ProtocolError);
  });

  it('survives fuzzing: random bytes never crash, only throw ProtocolError or decode consistently', () => {
    let x = 12345;
    const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) / 0x100000000;
    for (let i = 0; i < 5000; i++) {
      const len = Math.floor(rnd() * 64);
      const b = new Uint8Array(len);
      for (let j = 0; j < len; j++) b[j] = Math.floor(rnd() * 256);
      if (len >= HEADER_BYTES && rnd() < 0.5) {
        b[0] = 1;
        b[1] = 1 + Math.floor(rnd() * 10);
        new DataView(b.buffer).setUint32(16, len - HEADER_BYTES);
      }
      try {
        const f = decodeFrame(b);
        expect(f.payload.byteLength).toBe(len - HEADER_BYTES);
        expect(new Uint8Array(encodeFrame(f))).toEqual(b);
      } catch (e) {
        expect(e).toBeInstanceOf(ProtocolError);
      }
    }
    // Random valid frames round-trip.
    for (let i = 0; i < 2000; i++) {
      const f = {
        type: (1 + Math.floor(rnd() * 10)) as FrameType,
        flags: 0,
        file: Math.floor(rnd() * 0xffffffff),
        block: Math.floor(rnd() * 0xffffffff),
        offset: Math.floor(rnd() * 0xffffffff),
        payload: new Uint8Array(0),
      };
      expect(decodeFrame(encodeFrame(f))).toEqual(f);
    }
  });

  it('sizes blocks and frames', () => {
    expect(blockCount(0)).toBe(0);
    expect(blockCount(1)).toBe(1);
    expect(blockCount(4 * 1024 * 1024)).toBe(1);
    expect(blockCount(4 * 1024 * 1024 + 1)).toBe(2);
    expect(blockCount(20 * 1024 ** 3)).toBe(5120);
    expect(blockLength(10, 0, 4)).toBe(4);
    expect(blockLength(10, 2, 4)).toBe(2);
    expect(dataPerFrame(undefined)).toBe(65536 - 20);
    expect(dataPerFrame(16384)).toBe(16384 - 20);
    expect(dataPerFrame(1 << 30)).toBe(65536 - 20);
  });
});
