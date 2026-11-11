// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import { b64uDecode, b64uEncode, equalBytes, fromHex, hex } from './encoding';

describe('base64url', () => {
  it('matches Node for every length 0..64 and round-trips', () => {
    for (let n = 0; n <= 64; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = b64uEncode(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(hex(b64uDecode(text))).toBe(hex(bytes));
    }
  });

  it('rejects padding, other alphabets, impossible lengths, and non-canonical spare bits', () => {
    for (const bad of ['AA==', 'A+B/', 'A', 'AB$C']) expect(() => b64uDecode(bad)).toThrow(CryptoError);
    expect(() => b64uDecode('AB')).toThrow(/non-canonical/); // one byte, but the spare bits are not zero
    expect(hex(b64uDecode('AA'))).toBe('00');
  });
});

describe('hex and comparison', () => {
  it('round-trips hex and rejects malformed input', () => {
    expect(hex(fromHex('00ff10'))).toBe('00ff10');
    expect(() => fromHex('abc')).toThrow(CryptoError);
    expect(() => fromHex('zz')).toThrow(CryptoError);
  });

  it('compares bytes by value and length', () => {
    expect(equalBytes(fromHex('0102'), fromHex('0102'))).toBe(true);
    expect(equalBytes(fromHex('0102'), fromHex('0103'))).toBe(false);
    expect(equalBytes(fromHex('01'), fromHex('0101'))).toBe(false);
  });
});
