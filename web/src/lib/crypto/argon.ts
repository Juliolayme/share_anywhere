import { argon2id, argon2idAsync } from '@noble/hashes/argon2.js';
import { CryptoError, invalid } from './errors';
import { utf8, zeroize, type Bytes } from './encoding';
import { checkRecoveryPhrase, normalizePhrase } from './phrase';

/**
 * Recovery seed = Argon2id(password = normalized phrase, salt = 16 random bytes kept by the server,
 * m = 65536 KiB, t = 3, p = 1, 32 bytes) (contract §Crypto). Pure JS (@noble/hashes), so it needs no
 * `wasm-unsafe-eval` in the CSP; about 1 s on a laptop, so run it in a Worker (recovery.worker.ts).
 */
export interface Argon2Params {
  /** Memory in KiB. */
  m: number;
  /** Passes. */
  t: number;
  /** Lanes. */
  p: number;
}

export const RECOVERY_PARAMS: Readonly<Argon2Params> = Object.freeze({ m: 65536, t: 3, p: 1 });
export const RECOVERY_SALT_BYTES = 16;
export const RECOVERY_SEED_BYTES = 32;
// Accepted from the server on recovery: never weaker than v1 (a cheap seed would ease offline guessing of a
// leaked recovery blob) and bounded so a hostile response cannot exhaust the device.
const LIMITS = { m: [65536, 262144], t: [3, 10], p: [1, 4] } as const;

export function assertRecoveryParams(params: Argon2Params, salt: Uint8Array): void {
  for (const k of ['m', 't', 'p'] as const) {
    const [lo, hi] = LIMITS[k];
    const v = params[k];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw invalid(`Argon2id ${k} must be ${lo}..${hi}`);
  }
  if (salt.length !== RECOVERY_SALT_BYTES) throw invalid(`recovery salt must be ${RECOVERY_SALT_BYTES} bytes`);
}

function password(phrase: string): Bytes {
  const check = checkRecoveryPhrase(phrase);
  if (!check.ok) throw new CryptoError('invalid_phrase', check.reason);
  return utf8(normalizePhrase(phrase));
}

/** Synchronous Argon2id seed: call it inside a Worker (it blocks for about a second). */
export function recoverySeed(
  phrase: string,
  salt: Uint8Array,
  params: Argon2Params = RECOVERY_PARAMS,
  onProgress?: (fraction: number) => void,
): Bytes {
  assertRecoveryParams(params, salt);
  const pw = password(phrase);
  try {
    const out = argon2id(pw, salt, { ...pick(params), dkLen: RECOVERY_SEED_BYTES, ...(onProgress && { onProgress }) });
    return Uint8Array.from(out);
  } finally {
    zeroize(pw);
  }
}

/** Same seed, computed in slices that yield to the event loop: the fallback where Workers are missing. */
export async function recoverySeedAsync(
  phrase: string,
  salt: Uint8Array,
  params: Argon2Params = RECOVERY_PARAMS,
  onProgress?: (fraction: number) => void,
): Promise<Bytes> {
  assertRecoveryParams(params, salt);
  const pw = password(phrase);
  try {
    const opts = { ...pick(params), dkLen: RECOVERY_SEED_BYTES, asyncTick: 10, ...(onProgress && { onProgress }) };
    const out = await argon2idAsync(pw, salt, opts);
    return Uint8Array.from(out);
  } finally {
    zeroize(pw);
  }
}

function pick({ m, t, p }: Argon2Params): Argon2Params {
  return { m, t, p };
}
