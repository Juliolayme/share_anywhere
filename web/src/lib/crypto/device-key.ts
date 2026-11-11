import { b64uEncode } from './encoding';
import type { KeyStore } from './store';
import { generateX25519, hasWebCryptoX25519, type X25519KeyPair } from './x25519';

/**
 * Per-device X25519 wrapping keypair (contract §Crypto "Device wrapping key"). Rotation blobs are wrapped
 * to its public key, which the device registers with `PUT /v1/keys/device`; for pairing it is the
 * existing device's `sender_public_key`. With WebCrypto X25519 the private key is a non-extractable
 * CryptoKey; otherwise it falls back to @noble/curves and is kept encrypted under the device KEK
 * (x25519.ts, store.ts).
 */
export async function generateDeviceKeyPair(): Promise<X25519KeyPair> {
  return generateX25519();
}

/** The wire `public_key` (base64url, 32 bytes). */
export function publicKeyB64(keyPair: X25519KeyPair): string {
  return b64uEncode(keyPair.publicKey);
}

/** True when this browser keeps the device private key non-extractable (WebCrypto X25519). */
export async function deviceKeyIsHardened(): Promise<boolean> {
  return hasWebCryptoX25519();
}

/**
 * The stored device keypair, creating and saving one on first use. `created` tells the caller to register
 * the public key (`PUT /v1/keys/device`); re-registering an unchanged key is harmless.
 */
export async function getOrCreateDeviceKey(store: KeyStore): Promise<{ keyPair: X25519KeyPair; created: boolean }> {
  const existing = await store.loadDeviceKey();
  if (existing) return { keyPair: existing, created: false };
  const keyPair = await generateDeviceKeyPair();
  await store.saveDeviceKey(keyPair);
  return { keyPair, created: true };
}
