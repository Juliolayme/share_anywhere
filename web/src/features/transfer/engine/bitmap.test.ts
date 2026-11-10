import { describe, expect, it } from 'vitest';
import { Bitmap } from './bitmap';

describe('Bitmap', () => {
  it('sets, counts and lists missing blocks least-significant bit first', () => {
    const b = new Bitmap(10);
    expect(b.bytes.byteLength).toBe(2);
    expect(b.set(0)).toBe(true);
    expect(b.set(0)).toBe(false);
    b.set(3);
    b.set(9);
    expect([...b.bytes]).toEqual([0b00001001, 0b00000010]);
    expect(b.count).toBe(3);
    expect(b.missing()).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(b.full).toBe(false);
    expect(() => b.set(10)).toThrow(RangeError);
    expect(b.has(10)).toBe(false);
  });

  it('loads persisted bytes and refuses bits past the end', () => {
    const b = new Bitmap(10, new Uint8Array([0xff, 0x03]));
    expect(b.full).toBe(true);
    expect(() => new Bitmap(10, new Uint8Array([0xff, 0x07]))).toThrow(/past the last/);
    expect(() => new Bitmap(10, new Uint8Array([0xff]))).toThrow(/needs 2 bytes/);
  });

  it('merges out-of-order progress', () => {
    const a = new Bitmap(6);
    const b = new Bitmap(6);
    a.set(0);
    a.set(5);
    b.set(2);
    b.set(5);
    const m = a.merge(b);
    expect(m.missing()).toEqual([1, 3, 4]);
    expect(m.count).toBe(3);
    expect(() => a.merge(new Bitmap(7))).toThrow();
  });

  it('handles empty files and the 20 GB case', () => {
    expect(new Bitmap(0).full).toBe(true);
    const big = new Bitmap(5120);
    expect(big.bytes.byteLength).toBe(640);
  });
});
