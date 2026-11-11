import { FIRST_KEY_VERSION, generateAdk } from './adk';
import { invalid } from './errors';
import { assertVersion, b64uDecode, b64uEncode, zeroize } from './encoding';
import { createRecovery, deriveRecoveryKeyPair, type Argon2Params, type DeriveOptions } from './recovery';
import type { KeyStore } from './store';
import { unwrapAdk, wrapAdk } from './wrap';

/**
 * First-device key setup and phrase recovery (PRD §2 "Account key bootstrap", contract §Keys
 * `POST /v1/keys/setup`, `GET /v1/keys/recovery`).
 */
export interface SetupRequest {
  recovery_public_key: string;
  salt: string;
  params: Argon2Params;
  recovery_blob: string;
}

export interface PreparedSetup {
  request: SetupRequest;
  /** Show once; the user writes it down. Never store or send it. */
  phrase: string;
  keyVersion: number;
  /** Store ADK v1 once the server answered 201. */
  commit(): Promise<void>;
  /** Drop it after `409 keys_exist` (another device won): pair or recover instead. */
  discard(): void;
}

export async function prepareKeySetup(store: KeyStore, options: DeriveOptions = {}): Promise<PreparedSetup> {
  if ((await store.currentVersion()) !== 0) throw invalid('this device already holds an ADK');
  const recovery = await createRecovery(options);
  const adk = generateAdk(FIRST_KEY_VERSION);
  let blob: Uint8Array;
  try {
    blob = await wrapAdk(adk.raw, recovery.keyPair.publicKey, 'recovery', adk.version);
  } catch (err) {
    zeroize(adk.raw);
    throw err;
  }
  let done = false;
  return {
    request: {
      recovery_public_key: b64uEncode(recovery.keyPair.publicKey),
      salt: b64uEncode(recovery.salt),
      params: recovery.params,
      recovery_blob: b64uEncode(blob),
    },
    phrase: recovery.phrase,
    keyVersion: adk.version,
    async commit() {
      if (done) throw invalid('setup already committed or discarded');
      done = true;
      try {
        await store.saveAdk(adk.version, adk.raw);
      } finally {
        zeroize(adk.raw);
      }
    },
    discard() {
      done = true;
      zeroize(adk.raw);
    },
  };
}

/** `GET /v1/keys/recovery`. */
export interface RecoveryResponse {
  key_version: number;
  recovery_blob: string;
  salt: string;
  params: Argon2Params;
}

/**
 * Unwraps the newest ADK with the phrase and stores it. A wrong (but well-formed) phrase fails with
 * `decrypt_failed`; a malformed one with `invalid_phrase`. Follow with `importChain` for older versions.
 */
export async function recoverWithPhrase(
  store: KeyStore,
  phrase: string,
  response: RecoveryResponse,
  options: DeriveOptions = {},
): Promise<number> {
  assertVersion(response.key_version);
  const keyPair = await deriveRecoveryKeyPair(phrase, b64uDecode(response.salt), response.params, options);
  const raw = await unwrapAdk(b64uDecode(response.recovery_blob), keyPair, 'recovery', response.key_version);
  try {
    await store.saveAdk(response.key_version, raw);
  } finally {
    zeroize(raw);
  }
  return response.key_version;
}
