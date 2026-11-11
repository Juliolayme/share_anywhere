import { CryptoError } from './errors';
import { assertLength, copyBytes, type Bytes } from './encoding';

/** AES-GCM nonce length (96 bits) and tag length (128 bits), fixed by the protocol. */
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CryptoError('unsupported', 'WebCrypto is unavailable (an insecure context or an old browser)');
  return s;
}

/** HKDF-SHA256 to `length` bytes (protocol use: 32-byte keys only). */
export async function hkdfBytes(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Promise<Bytes> {
  const base = await subtle().importKey('raw', copyBytes(ikm), 'HKDF', false, ['deriveBits']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: copyBytes(salt), info: new TextEncoder().encode(info) };
  return new Uint8Array(await subtle().deriveBits(params, base, length * 8));
}

/** HKDF-SHA256 straight into a non-extractable AES-256-GCM key, so the derived bytes never reach script. */
export async function hkdfAesKey(base: CryptoKey, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const params = { name: 'HKDF', hash: 'SHA-256', salt: copyBytes(salt), info: new TextEncoder().encode(info) };
  return subtle().deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function hkdfBase(ikm: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', copyBytes(ikm), 'HKDF', false, ['deriveKey', 'deriveBits']);
}

export async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  assertLength(raw, 32, 'AES-256 key');
  return subtle().importKey('raw', copyBytes(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function gcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Bytes> {
  assertLength(nonce, NONCE_BYTES, 'nonce');
  const params = { name: 'AES-GCM', iv: copyBytes(nonce), additionalData: copyBytes(aad), tagLength: TAG_BYTES * 8 };
  return new Uint8Array(await subtle().encrypt(params, key, copyBytes(plaintext)));
}

/** AES-GCM open; any authentication failure becomes `decrypt_failed` without detail (no oracle). */
export async function gcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Bytes> {
  assertLength(nonce, NONCE_BYTES, 'nonce');
  if (ciphertext.length < TAG_BYTES) throw new CryptoError('decrypt_failed', 'ciphertext shorter than the tag');
  const params = { name: 'AES-GCM', iv: copyBytes(nonce), additionalData: copyBytes(aad), tagLength: TAG_BYTES * 8 };
  try {
    return new Uint8Array(await subtle().decrypt(params, key, copyBytes(ciphertext)));
  } catch (cause) {
    throw new CryptoError('decrypt_failed', 'authentication failed', { cause });
  }
}
