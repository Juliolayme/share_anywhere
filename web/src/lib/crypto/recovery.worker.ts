import { recoverySeed, type Argon2Params } from './argon';
import { CryptoError } from './errors';

/**
 * Runs the Argon2id recovery derivation off the main thread (recovery.ts `deriveRecoveryKeyPair`).
 * In: {phrase, salt, params}. Out: {type: 'progress', fraction} …, then {type: 'done', seed} (seed buffer
 * transferred) or {type: 'error', code, message}. One request per worker; the caller terminates it.
 */
export interface SeedRequest {
  phrase: string;
  salt: Uint8Array;
  params: Argon2Params;
}

export type SeedResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; seed: Uint8Array }
  | { type: 'error'; code: string; message: string };

// The app compiles against the DOM lib only; this is the slice of DedicatedWorkerGlobalScope used here.
interface WorkerScope {
  onmessage: ((event: MessageEvent<SeedRequest>) => void) | null;
  postMessage(message: SeedResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { phrase, salt, params } = event.data;
  try {
    let last = 0;
    const seed = recoverySeed(phrase, salt, params, (fraction) => {
      if (fraction - last >= 0.05 || fraction === 1) {
        last = fraction;
        scope.postMessage({ type: 'progress', fraction } satisfies SeedResponse);
      }
    });
    scope.postMessage({ type: 'done', seed } satisfies SeedResponse, [seed.buffer]);
  } catch (err) {
    const code = err instanceof CryptoError ? err.code : 'unsupported';
    scope.postMessage({
      type: 'error',
      code,
      message: err instanceof Error ? err.message : 'failed',
    } satisfies SeedResponse);
  }
};
