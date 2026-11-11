// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hex } from './encoding';
import { generateX25519, x25519FromSecret, x25519SharedSecret } from './x25519';

afterEach(() => vi.restoreAllMocks());

// WebKit on Linux (Playwright's WebKit) rejects X25519 private scalars whose first byte is zero: pkcs8 import
// throws DataError and generateKey throws OperationError, about 1 in 32 of the time.
describe('X25519 backend quirks', () => {
  it('a scalar the engine refuses to import falls back to the JS backend with the same public key', async () => {
    const secret = new Uint8Array(32).fill(7);
    secret[0] = 3; // clamps to a leading zero byte
    const native = await x25519FromSecret(secret);
    expect(native.privateKey.kind).toBe('webcrypto');
    const real = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((format: string, ...rest: unknown[]) =>
      format === 'pkcs8'
        ? Promise.reject(new DOMException('Data provided to an operation does not meet requirements', 'DataError'))
        : (real as (...a: unknown[]) => Promise<CryptoKey>)(format, ...rest)) as typeof crypto.subtle.importKey);
    const fallback = await x25519FromSecret(secret);
    expect(fallback.privateKey.kind).toBe('raw');
    expect(hex(fallback.publicKey)).toBe(hex(native.publicKey));
    const peer = await generateX25519();
    expect(hex(await x25519SharedSecret(fallback.privateKey, peer.publicKey))).toBe(
      hex(await x25519SharedSecret(native.privateKey, peer.publicKey)),
    );
  });

  it('a failed native generation is retried with a fresh key', async () => {
    const real = crypto.subtle.generateKey.bind(crypto.subtle);
    let calls = 0;
    vi.spyOn(crypto.subtle, 'generateKey').mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 1 && (args[0] as { name?: string }).name === 'X25519')
        return Promise.reject(new DOMException('The operation failed', 'OperationError'));
      return (real as (...a: unknown[]) => Promise<CryptoKeyPair>)(...args);
    }) as typeof crypto.subtle.generateKey);
    const pair = await generateX25519();
    expect(pair.privateKey.kind).toBe('webcrypto');
    expect(pair.publicKey).toHaveLength(32);
  });
});
