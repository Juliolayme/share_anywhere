import { FIRST_KEY_VERSION, generateAdk } from './adk';
import {
  assertAdkMatchesVersion,
  assertAnchoredOnHeld,
  assertRecoveryKeySigned,
  recoveryAnchor,
  recoveryKeySignature,
  verifyKeyOf,
  verifySignatureChain,
  versionVerifyKey,
  type ChainState,
} from './authenticity';
import { CryptoError, invalid } from './errors';
import { assertVersion, b64uDecode, b64uEncode, equalBytes, zeroize, type Bytes } from './encoding';
import { createRecovery, deriveRecoveryMaterial, type Argon2Params, type DeriveOptions } from './recovery';
import type { KeyStore } from './store';
import { unwrapAdk, wrapAdk } from './wrap';

/**
 * First-device key setup and phrase recovery (PRD §2 "Account key bootstrap", contract §Keys
 * `POST /v1/keys/setup`, `GET /v1/keys/recovery`; key authenticity: docs/CLIPBOARD_PROTOCOL.md §1).
 */
export interface SetupRequest {
  recovery_public_key: string;
  salt: string;
  params: Argon2Params;
  recovery_blob: string;
  /** verify_key(1), the Ed25519 public key derived from ADK v1. */
  verify_key: string;
  /** HMAC of verify_key(1) under a key only the recovery phrase derives. */
  recovery_anchor: string;
  /** Ed25519 by ADK v1 over `"sa-recoverykey-v1|" + b64u(recovery_public_key)` (contract H.1). */
  recovery_key_signature: string;
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
  let verifyKey: Bytes;
  let anchor: Bytes;
  let recoveryKeySig: Bytes;
  try {
    blob = await wrapAdk(adk.raw, recovery.keyPair.publicKey, 'recovery', adk.version);
    verifyKey = await verifyKeyOf(adk.raw);
    anchor = await recoveryAnchor(recovery.anchorKey, verifyKey);
    // Vouches for the recovery public key with ADK v1, so later rotations never wrap to a key the server chose.
    recoveryKeySig = await recoveryKeySignature(adk.raw, recovery.keyPair.publicKey);
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
      verify_key: b64uEncode(verifyKey),
      recovery_anchor: b64uEncode(anchor),
      recovery_key_signature: b64uEncode(recoveryKeySig),
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
  /** Null for a legacy account created before key authenticity. */
  recovery_anchor: string | null;
}

/** `recovery` of `GET /v1/keys`: the recovery public key and the setup signature over it (null for legacy accounts). */
export interface RecoveryKeyInfo {
  public_key: string;
  /** Required by the API; a missing value (undefined) is treated as unsigned. */
  signature?: string | null | undefined;
}

function recoveryUnverified(message: string, cause?: unknown): CryptoError {
  return new CryptoError('recovery_unverified', message, cause === undefined ? undefined : { cause });
}

/**
 * Unwraps the newest ADK with the phrase, verifies it, and stores it. A wrong (but well-formed) phrase fails with
 * `decrypt_failed`; a malformed one with `invalid_phrase`. Before anything is stored (contract A.6 "Recovery"):
 * - the recovery anchor, which only the phrase can compute, must authenticate `versions[1].verify_key`;
 * - the recovery public key the phrase derives must equal `recoveryKey.public_key` (`GET /v1/keys`), and
 *   `recoveryKey.signature` must verify with that `versions[1].verify_key` (contract H.4), so the key later rotations
 *   wrap to is the phrase's own;
 * - every rotation 2..v must be signed by the version before it (`chain` = `GET /v1/keys/chain`);
 * - the recovered ADK(v) must derive `versions[v].verify_key`;
 * - when this device already holds an ADK, the account must also be consistent with it (contract F.1,
 *   {@link assertAnchoredOnHeld}): a server cannot roll the device back or swap the history it knows.
 * Any failure is `recovery_unverified`; a legacy account (no anchor) is `keys_legacy`. Follow with `importChain`.
 */
export async function recoverWithPhrase(
  store: KeyStore,
  phrase: string,
  response: RecoveryResponse,
  chain: ChainState,
  recoveryKey: RecoveryKeyInfo | null,
  options: DeriveOptions = {},
): Promise<number> {
  const v = response.key_version;
  assertVersion(v);
  const { keyPair, anchorKey } = await deriveRecoveryMaterial(
    phrase,
    b64uDecode(response.salt),
    response.params,
    options,
  );
  const raw = await unwrapAdk(b64uDecode(response.recovery_blob), keyPair, 'recovery', v);
  try {
    if (response.recovery_anchor === null) {
      throw new CryptoError('keys_legacy', 'this account has no recovery anchor: its keys must be set up again');
    }
    try {
      const verifyKeyV1 = versionVerifyKey(chain.versions, 1);
      const expected = await recoveryAnchor(anchorKey, verifyKeyV1);
      if (!equalBytes(expected, b64uDecode(response.recovery_anchor))) {
        throw recoveryUnverified('the recovery anchor does not match the first verify key');
      }
      // verify_key(1) is now anchored to the phrase: the recovery key on record must be the phrase's and signed by it.
      if (!recoveryKey || !equalBytes(keyPair.publicKey, b64uDecode(recoveryKey.public_key))) {
        throw recoveryUnverified('the account lists another recovery key than this phrase derives');
      }
      assertRecoveryKeySigned(recoveryKey.public_key, recoveryKey.signature, verifyKeyV1);
      verifySignatureChain(chain, v);
      await assertAdkMatchesVersion(raw, chain.versions, v);
      await assertAnchoredOnHeld(store, chain, v, raw);
    } catch (err) {
      if (err instanceof CryptoError && (err.code === 'keys_legacy' || err.code === 'recovery_unverified')) throw err;
      throw recoveryUnverified('the recovered key does not verify against the account', err);
    }
    await store.saveAdk(v, raw);
  } finally {
    zeroize(raw);
  }
  return v;
}
