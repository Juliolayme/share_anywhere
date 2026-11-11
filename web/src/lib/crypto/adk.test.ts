// @vitest-environment node
import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ADK_BYTES, SUBKEY_INFO, deriveSubkey, deriveSubkeyBytes, generateAdk } from './adk';
import { fromHex, hex } from './encoding';
import { encryptItemWithNonce } from './item';
import { aesKey } from './primitives';

const ADK = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

describe('ADK', () => {
  it('generates 32 random bytes with a positive version', () => {
    const a = generateAdk();
    const b = generateAdk(7);
    expect(a.version).toBe(1);
    expect(b.version).toBe(7);
    expect(a.raw).toHaveLength(ADK_BYTES);
    expect(hex(a.raw)).not.toBe(hex(b.raw));
    expect(() => generateAdk(0)).toThrow();
    expect(() => generateAdk(1.5)).toThrow();
  });

  it('derives the clipboard-v1 and history-v1 subkeys with HKDF-SHA256 (fixed vectors, checked against Node)', async () => {
    const expected = {
      clipboard: 'fc4c00a42111f03eb56325d210ed7c69fdbf984ac25b81f79b105824f5d83f4e',
      history: '31fd4c6ebfa152b21f318ec82af766c0f42d53a5716e23bd027f252a0c9b3e18',
    };
    for (const purpose of ['clipboard', 'history'] as const) {
      const bytes = await deriveSubkeyBytes(ADK, purpose);
      expect(hex(bytes)).toBe(expected[purpose]);
      const node = Buffer.from(hkdfSync('sha256', ADK, new Uint8Array(0), SUBKEY_INFO[purpose], 32));
      expect(hex(bytes)).toBe(node.toString('hex'));
    }
  });

  it('imports subkeys as non-extractable AES-GCM keys equal to the derived bytes', async () => {
    const key = await deriveSubkey(ADK, 'history');
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    const nonce = new Uint8Array(12);
    const viaDerived = await encryptItemWithNonce(key, 'e1', 1, 'x', nonce);
    const viaBytes = await encryptItemWithNonce(
      await aesKey(await deriveSubkeyBytes(ADK, 'history')),
      'e1',
      1,
      'x',
      nonce,
    );
    expect(hex(viaDerived.ciphertext)).toBe(hex(viaBytes.ciphertext));
  });

  it('separates purposes and rejects malformed input', async () => {
    expect(hex(await deriveSubkeyBytes(ADK, 'clipboard'))).not.toBe(hex(await deriveSubkeyBytes(ADK, 'history')));
    await expect(deriveSubkey(new Uint8Array(31), 'history')).rejects.toThrow();
    // @ts-expect-error unknown purpose
    await expect(deriveSubkey(ADK, 'files')).rejects.toThrow();
  });
});
