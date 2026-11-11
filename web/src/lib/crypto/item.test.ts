// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveSubkey, generateAdk } from './adk';
import { CryptoError } from './errors';
import { hex } from './encoding';
import {
  decryptItem,
  decryptItemText,
  encryptItem,
  isItemId,
  itemAad,
  itemFromWire,
  itemIdFromBytes,
  itemToWire,
  newItemId,
  toItemId,
} from './item';

const ID = '6f1e1b5a-3c1d-4a7e-9b2f-0c8d5e4a3b21';

async function key(purpose: 'history' | 'clipboard' = 'history') {
  return deriveSubkey(generateAdk().raw, purpose);
}

async function expectDecryptFailed(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ code: 'decrypt_failed' });
}

describe('item encryption', () => {
  it('round-trips text and bytes with a 12-byte nonce and a 16-byte tag', async () => {
    const k = await key();
    const enc = await encryptItem(k, ID, 3, 'Xin chào ✓');
    expect(enc.nonce).toHaveLength(12);
    expect(enc.ciphertext).toHaveLength(new TextEncoder().encode('Xin chào ✓').length + 16);
    expect(await decryptItemText(k, ID, 3, enc)).toBe('Xin chào ✓');
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    expect(hex(await decryptItem(k, ID, 3, await encryptItem(k, ID, 3, bytes)))).toBe('000102ff');
  });

  it('binds the AAD "<id>|<key_version>" and detects every tampering', async () => {
    const k = await key();
    expect(new TextDecoder().decode(itemAad(ID, 2))).toBe(`${ID}|2`);
    const enc = await encryptItem(k, ID, 2, 'secret');
    await expectDecryptFailed(decryptItem(k, 'another-id', 2, enc));
    await expectDecryptFailed(decryptItem(k, ID, 3, enc));
    await expectDecryptFailed(decryptItem(await key(), ID, 2, enc));
    for (const field of ['nonce', 'ciphertext'] as const) {
      for (const at of [0, enc[field].length - 1]) {
        const copy = { nonce: Uint8Array.from(enc.nonce), ciphertext: Uint8Array.from(enc.ciphertext) };
        copy[field][at] = (copy[field][at] ?? 0) ^ 1;
        await expectDecryptFailed(decryptItem(k, ID, 2, copy));
      }
    }
    await expectDecryptFailed(decryptItem(k, ID, 2, { nonce: enc.nonce, ciphertext: enc.ciphertext.subarray(0, 8) }));
  });

  it('keeps clipboard and history subkeys apart', async () => {
    const adk = generateAdk().raw;
    const enc = await encryptItem(await deriveSubkey(adk, 'clipboard'), ID, 1, 'x');
    await expectDecryptFailed(decryptItem(await deriveSubkey(adk, 'history'), ID, 1, enc));
  });

  it('draws a fresh nonce for each of 10,000 encryptions', async () => {
    const k = await key();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(hex((await encryptItem(k, ID, 1, 'same')).nonce));
    expect(seen.size).toBe(10_000);
  }, 60_000);

  it('rejects ambiguous ids and bad versions, and converts to and from the wire shape', async () => {
    const k = await key();
    await expect(encryptItem(k, 'a|b', 1, 'x')).rejects.toBeInstanceOf(CryptoError);
    await expect(encryptItem(k, '', 1, 'x')).rejects.toBeInstanceOf(CryptoError);
    await expect(encryptItem(k, ID, 0, 'x')).rejects.toBeInstanceOf(CryptoError);
    const enc = await encryptItem(k, ID, 1, 'wire');
    const wire = itemToWire(enc);
    expect(wire.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await decryptItemText(k, ID, 1, itemFromWire(wire))).toBe('wire');
    expect(() => itemFromWire({ nonce: 'AAAA', ciphertext: wire.ciphertext })).toThrow(CryptoError);
  });

  it('item ids are lowercase canonical 8-4-4-4-12 hex UUIDs, and the AAD uses exactly that text (§1.3)', async () => {
    for (let i = 0; i < 200; i++) {
      const id = newItemId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isItemId(id)).toBe(true);
    }
    expect(toItemId(ID.toUpperCase())).toBe(ID);
    for (const bad of [`{${ID}}`, ID.replace(/-/g, ''), `urn:uuid:${ID}`, `${ID} `, 'evt-1', ''])
      expect(() => toItemId(bad)).toThrow(CryptoError);
    expect(isItemId(ID.toUpperCase())).toBe(false);
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
    expect(itemIdFromBytes(bytes)).toBe('a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf');
    expect(() => itemIdFromBytes(bytes.slice(0, 15))).toThrow(CryptoError);
    // Another text form of the same UUID is another AAD: it never authenticates (the server rejects it with 400 too).
    const k = await key('clipboard');
    const enc = await encryptItem(k, ID, 1, 'same uuid, other text');
    await expectDecryptFailed(decryptItemText(k, ID.toUpperCase(), 1, enc));
    expect(new TextDecoder().decode(itemAad(ID, 1))).toBe(`${ID}|1`);
  });
});
