import { deviceKeyProof, type DeviceKeyRegistration } from './authenticity';
import { b64uEncode, zeroize } from './encoding';
import type { KeyStore } from './store';
import { KeyStoreUnavailableError } from './errors';
import { generateX25519, generateX25519Raw, hasWebCryptoX25519, type X25519KeyPair } from './x25519';

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
 * The stored device keypair, creating and saving one on first use (read back once, falling back to the JS
 * backend where the engine cannot restore a stored WebCrypto X25519 key). `created` tells the caller to register
 * the public key (`PUT /v1/keys/device`); re-registering an unchanged key is harmless.
 */
export async function getOrCreateDeviceKey(store: KeyStore): Promise<{ keyPair: X25519KeyPair; created: boolean }> {
  const existing = await store.loadDeviceKey();
  if (existing) return { keyPair: existing, created: false };
  let keyPair = await generateDeviceKeyPair();
  await store.saveDeviceKey(keyPair);
  if (keyPair.privateKey.kind === 'webcrypto' && !(await store.loadDeviceKey())) {
    // Some engines (WebKit) accept a WebCrypto X25519 key into IndexedDB but read the record back as undefined.
    // Keep the private scalar encrypted under the non-extractable device KEK instead (the fallback backend).
    keyPair = await generateX25519Raw();
    await store.saveDeviceKey(keyPair);
    if (!(await store.loadDeviceKey())) throw new KeyStoreUnavailableError('the device key does not survive storage');
  }
  return { keyPair, created: true };
}

/**
 * The `PUT /v1/keys/device` body for this device (contract A.4): the wrapping public key with a proof signed by the
 * newest ADK version the device holds. Null while the device holds no ADK: a device registers only once it has the
 * key (after setup, pairing or recovery), so rotations never wrap new keys to a device that was never given one.
 */
export async function proveDeviceKey(
  store: KeyStore,
  deviceId: string,
  keyPair: X25519KeyPair,
): Promise<DeviceKeyRegistration | null> {
  const version = await store.currentVersion();
  if (version === 0) return null;
  const raw = await store.unwrapAdkRaw(version);
  try {
    return await deviceKeyProof(raw, version, deviceId, keyPair.publicKey);
  } finally {
    zeroize(raw);
  }
}
