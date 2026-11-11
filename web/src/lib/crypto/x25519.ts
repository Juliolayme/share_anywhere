import { CryptoError } from './errors';
import { assertLength, copyBytes, randomBytes, zeroize, type Bytes } from './encoding';
import { subtle } from './primitives';

/**
 * X25519 behind two backends (docs/CLIPBOARD_PROTOCOL.md §Keys "Device wrapping key"):
 * - `webcrypto`: native X25519 with a non-extractable private `CryptoKey` (Chrome 133+, Firefox 130+,
 *   Safari 17+, Node 22). Preferred whenever the runtime supports it.
 * - `raw`: the audited @noble/curves implementation for browsers without WebCrypto X25519 (for example
 *   Safari 16). The private scalar is then script-visible bytes; the key store keeps it encrypted under the
 *   non-extractable device KEK at rest. Loaded lazily so it costs nothing where WebCrypto suffices.
 */
export type X25519PrivateKey = { kind: 'webcrypto'; key: CryptoKey } | { kind: 'raw'; bytes: Bytes };

export interface X25519KeyPair {
  privateKey: X25519PrivateKey;
  /** 32-byte u-coordinate (RFC 7748), the wire `public_key`. */
  publicKey: Bytes;
}

export const X25519_BYTES = 32;
const ALG = { name: 'X25519' } as const;
// PKCS #8 prefix for an X25519 private key (RFC 8410): WebCrypto cannot import a raw private scalar.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
const BASE_POINT = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 : 0));

type Backend = 'webcrypto' | 'noble';
let forced: Backend | null = null;
let probe: Promise<boolean> | null = null;

/** Test hook: pin a backend (null restores detection). @internal */
export function forceX25519Backend(backend: Backend | null): void {
  forced = backend;
}

/** True when the runtime offers native X25519 key generation, import, and derivation. */
export async function hasWebCryptoX25519(): Promise<boolean> {
  if (forced) return forced === 'webcrypto';
  probe ??= (async () => {
    try {
      const pair = (await subtle().generateKey(ALG, false, ['deriveBits'])) as CryptoKeyPair;
      const pub = await subtle().exportKey('raw', pair.publicKey);
      const peer = await subtle().importKey('raw', pub, ALG, false, []);
      await subtle().deriveBits({ name: 'X25519', public: peer }, pair.privateKey, 256);
      return true;
    } catch {
      return false;
    }
  })();
  return probe;
}

async function noble() {
  return (await import('@noble/curves/ed25519.js')).x25519;
}

/** RFC 7748 clamping of a 32-byte scalar (returns a copy). */
export function clampScalar(secret: Uint8Array): Bytes {
  assertLength(secret, X25519_BYTES, 'X25519 private key');
  const k = copyBytes(secret);
  k[0] = (k[0] ?? 0) & 248;
  k[31] = ((k[31] ?? 0) & 127) | 64;
  return k;
}

/** A fresh keypair; the private key is non-extractable on the WebCrypto backend. */
export async function generateX25519(): Promise<X25519KeyPair> {
  if (await hasWebCryptoX25519()) {
    // WebKit on Linux fails about one generation in 32 with OperationError (a private scalar whose first byte
    // is zero); every attempt draws a fresh scalar, so a few retries make a failure vanishingly rare.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const pair = (await subtle().generateKey(ALG, false, ['deriveBits'])) as CryptoKeyPair;
        const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
        return { privateKey: { kind: 'webcrypto', key: pair.privateKey }, publicKey };
      } catch {
        /* next attempt */
      }
    }
  }
  return x25519FromSecret(randomBytes(X25519_BYTES));
}

/**
 * A fresh keypair on the JS backend (@noble/curves): the private scalar is returned as bytes for the caller to
 * keep encrypted (the device key store's fallback where a WebCrypto X25519 key cannot be stored).
 */
export async function generateX25519Raw(): Promise<X25519KeyPair> {
  const k = clampScalar(randomBytes(X25519_BYTES));
  const x = await noble();
  return { privateKey: { kind: 'raw', bytes: k }, publicKey: copyBytes(x.getPublicKey(k)) };
}

/**
 * Keypair from a 32-byte secret (recovery seed, fixed test vectors). The secret is clamped first; on the
 * WebCrypto backend the result is non-extractable and the caller should zeroize `secret`.
 */
export async function x25519FromSecret(secret: Uint8Array): Promise<X25519KeyPair> {
  const k = clampScalar(secret);
  if (await hasWebCryptoX25519()) {
    const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + X25519_BYTES);
    pkcs8.set(PKCS8_PREFIX);
    pkcs8.set(k, PKCS8_PREFIX.length);
    try {
      const key = await subtle().importKey('pkcs8', pkcs8, ALG, false, ['deriveBits']);
      // X25519(k, 9) is the public key; derive it natively instead of loading a JS curve.
      const base = await subtle().importKey('raw', copyBytes(BASE_POINT), ALG, false, []);
      const publicKey = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: base }, key, 256));
      zeroize(k);
      return { privateKey: { kind: 'webcrypto', key }, publicKey };
    } catch {
      // WebKit on Linux rejects every scalar whose first byte is zero (DataError, 1 in 32 after clamping), so a
      // given recovery seed would never import there: use the JS backend for this key (same X25519 result).
    } finally {
      zeroize(pkcs8);
    }
  }
  const x = await noble();
  return { privateKey: { kind: 'raw', bytes: k }, publicKey: copyBytes(x.getPublicKey(k)) };
}

/** X25519(private, peer); rejects malformed and low-order peer keys (all-zero shared secret). */
export async function x25519SharedSecret(privateKey: X25519PrivateKey, peerPublic: Uint8Array): Promise<Bytes> {
  assertLength(peerPublic, X25519_BYTES, 'X25519 public key');
  let shared: Bytes;
  try {
    if (privateKey.kind === 'webcrypto') {
      const peer = await subtle().importKey('raw', copyBytes(peerPublic), ALG, false, []);
      shared = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: peer }, privateKey.key, 256));
    } else {
      shared = copyBytes((await noble()).getSharedSecret(privateKey.bytes, peerPublic));
    }
  } catch (cause) {
    throw new CryptoError('invalid_input', 'X25519 rejected the public key', { cause });
  }
  if (shared.every((b) => b === 0)) throw new CryptoError('invalid_input', 'X25519 public key has low order');
  return shared;
}
