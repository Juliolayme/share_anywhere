import { assertLength, assertVersion, randomBytes, type Bytes } from './encoding';
import { hkdfAesKey, hkdfBase, hkdfBytes } from './primitives';

/**
 * Account Data Key (PRD §7.5, docs/CLIPBOARD_PROTOCOL.md §Keys): 32 random bytes per `key_version`
 * (starting at 1). It is never used directly; HKDF-SHA256 (salt empty) derives one AES-256-GCM key per purpose.
 */
export const ADK_BYTES = 32;
export const FIRST_KEY_VERSION = 1;

export const SUBKEY_INFO = { clipboard: 'clipboard-v1', history: 'history-v1' } as const;
export type SubkeyPurpose = keyof typeof SUBKEY_INFO;
export const SUBKEY_PURPOSES = Object.keys(SUBKEY_INFO) as SubkeyPurpose[];

const EMPTY_SALT = new Uint8Array(0);

export interface Adk {
  version: number;
  /** Transient raw key bytes; hand to the key store and zeroize. */
  raw: Bytes;
}

export function generateAdk(version: number = FIRST_KEY_VERSION): Adk {
  assertVersion(version);
  return { version, raw: randomBytes(ADK_BYTES) };
}

export function assertPurpose(purpose: string): asserts purpose is SubkeyPurpose {
  if (!Object.hasOwn(SUBKEY_INFO, purpose)) throw new TypeError(`unknown subkey purpose ${purpose}`);
}

/** Subkey from raw ADK bytes, imported as a non-extractable AES-256-GCM key. */
export async function deriveSubkey(adkRaw: Uint8Array, purpose: SubkeyPurpose): Promise<CryptoKey> {
  assertLength(adkRaw, ADK_BYTES, 'ADK');
  return deriveSubkeyFrom(await hkdfBase(adkRaw), purpose);
}

/** Subkey from an HKDF base key (the key store unwraps the ADK straight into one, never into script memory). */
export async function deriveSubkeyFrom(hkdf: CryptoKey, purpose: SubkeyPurpose): Promise<CryptoKey> {
  assertPurpose(purpose);
  return hkdfAesKey(hkdf, EMPTY_SALT, SUBKEY_INFO[purpose]);
}

/** Raw subkey bytes: test vectors and cross-platform checks only, never for runtime keys. */
export async function deriveSubkeyBytes(adkRaw: Uint8Array, purpose: SubkeyPurpose): Promise<Bytes> {
  assertLength(adkRaw, ADK_BYTES, 'ADK');
  assertPurpose(purpose);
  return hkdfBytes(adkRaw, EMPTY_SALT, SUBKEY_INFO[purpose]);
}
