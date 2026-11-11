import {
  RECOVERY_PARAMS,
  RECOVERY_SALT_BYTES,
  assertRecoveryParams,
  recoverySeedAsync,
  type Argon2Params,
} from './argon';
import { anchorKeyFromSeed } from './authenticity';
import { CryptoError } from './errors';
import { copyBytes, randomBytes, zeroize, type Bytes } from './encoding';
import { generatePhrase } from './phrase';
import type { SeedRequest, SeedResponse } from './recovery.worker';
import { x25519FromSecret, type X25519KeyPair } from './x25519';

/**
 * Recovery phrase → X25519 recovery keypair (contract §Crypto "Recovery"):
 *   seed = Argon2id(normalized phrase, salt, m=65536 KiB, t=3, p=1, 32 bytes)
 *   recovery private key = clamp(seed); recovery_public_key = X25519(private, 9)
 * The server stores the public key, salt, and params, plus the newest ADK wrapped to the public key
 * (purpose `recovery`). The phrase itself never leaves the device.
 */
export {
  RECOVERY_ENTROPY_BYTES,
  RECOVERY_WORDS,
  checkRecoveryPhrase,
  entropyToPhrase,
  generatePhrase,
  isRecoveryPhrase,
  normalizePhrase,
  phraseToEntropy,
  suggestWords,
  type PhraseCheck,
  type PhraseProblem,
} from './phrase';
export {
  RECOVERY_PARAMS,
  RECOVERY_SALT_BYTES,
  RECOVERY_SEED_BYTES,
  recoverySeed,
  recoverySeedAsync,
  type Argon2Params,
} from './argon';

export function generateRecoverySalt(): Bytes {
  return randomBytes(RECOVERY_SALT_BYTES);
}

export interface DeriveOptions {
  /** Run Argon2id in a Web Worker when the runtime has Workers (default true). */
  worker?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException('recovery derivation aborted', 'AbortError');
}

function seedInWorker(phrase: string, salt: Uint8Array, params: Argon2Params, options: DeriveOptions): Promise<Bytes> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./recovery.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      // A blocked worker (CSP, sandbox): derive on the main thread in yielding slices instead.
      resolve(recoverySeedAsync(phrase, salt, params, options.onProgress));
      return;
    }
    const finish = () => {
      worker.terminate();
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<SeedResponse>) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        options.onProgress?.(msg.fraction);
        return;
      }
      finish();
      if (msg.type === 'done') resolve(copyBytes(msg.seed));
      else reject(new CryptoError(msg.code === 'invalid_phrase' ? 'invalid_phrase' : 'invalid_input', msg.message));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
      resolve(recoverySeedAsync(phrase, salt, params, options.onProgress));
    };
    const request: SeedRequest = { phrase, salt: copyBytes(salt), params: { m: params.m, t: params.t, p: params.p } };
    worker.postMessage(request);
  });
}

/** The 32-byte Argon2id seed, off the main thread where possible. Zeroize it after use. */
export async function deriveRecoverySeed(
  phrase: string,
  salt: Uint8Array,
  params: Argon2Params = RECOVERY_PARAMS,
  options: DeriveOptions = {},
): Promise<Bytes> {
  assertRecoveryParams(params, salt);
  if (options.signal?.aborted) throw abortError();
  if (options.worker !== false && typeof Worker !== 'undefined') return seedInWorker(phrase, salt, params, options);
  return recoverySeedAsync(phrase, salt, params, options.onProgress);
}

/** The recovery keypair (non-extractable private key on the WebCrypto X25519 backend). */
export async function deriveRecoveryKeyPair(
  phrase: string,
  salt: Uint8Array,
  params: Argon2Params = RECOVERY_PARAMS,
  options: DeriveOptions = {},
): Promise<X25519KeyPair> {
  return (await deriveRecoveryMaterial(phrase, salt, params, options)).keyPair;
}

/** What the Argon2id seed yields; the seed itself is erased before this is returned. */
export interface RecoveryMaterial {
  keyPair: X25519KeyPair;
  /** Non-extractable HMAC key of the recovery anchor (docs/CLIPBOARD_PROTOCOL.md §1 "Key authenticity"). */
  anchorKey: CryptoKey;
}

/** The recovery keypair and anchor key from one Argon2id run; the seed is zeroized as soon as both exist. */
export async function deriveRecoveryMaterial(
  phrase: string,
  salt: Uint8Array,
  params: Argon2Params = RECOVERY_PARAMS,
  options: DeriveOptions = {},
): Promise<RecoveryMaterial> {
  const seed = await deriveRecoverySeed(phrase, salt, params, options);
  try {
    const keyPair = await x25519FromSecret(seed);
    return { keyPair, anchorKey: await anchorKeyFromSeed(seed) };
  } finally {
    zeroize(seed);
  }
}

export interface NewRecovery extends RecoveryMaterial {
  /** Shown once, never stored or sent. */
  phrase: string;
  salt: Bytes;
  params: Argon2Params;
}

/** A fresh phrase, salt, and the keypair and anchor key they derive (first-device setup). */
export async function createRecovery(options: DeriveOptions = {}): Promise<NewRecovery> {
  const phrase = generatePhrase();
  const salt = generateRecoverySalt();
  const params = { ...RECOVERY_PARAMS };
  const material = await deriveRecoveryMaterial(phrase, salt, params, options);
  return { phrase, salt, params, ...material };
}
