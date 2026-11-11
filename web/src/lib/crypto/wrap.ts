import { ADK_BYTES } from './adk';
import { CryptoError, invalid } from './errors';
import {
  assertLength,
  assertVersion,
  concatBytes,
  equalBytes,
  randomBytes,
  utf8,
  zeroize,
  type Bytes,
} from './encoding';
import { NONCE_BYTES, TAG_BYTES, aesKey, gcmDecrypt, gcmEncrypt, hkdfAesKey, hkdfBase } from './primitives';
import { X25519_BYTES, generateX25519, x25519SharedSecret, type X25519KeyPair } from './x25519';

/**
 * Wrapping the ADK to an X25519 public key (contract §Crypto, docs/CLIPBOARD_PROTOCOL.md §Keys):
 *   shared = X25519(eph_priv, recipient_pub)
 *   key    = HKDF-SHA256(ikm = shared, salt = eph_pub || recipient_pub, info = "sa-wrap-v1")
 *   blob   = eph_pub(32) || nonce(12) || AES-256-GCM(key, nonce, ADK, aad = "<purpose>|<key_version>")
 * For pairing the sender's device key takes the ephemeral key's place (its public half is
 * `sender_public_key`). The AAD makes a blob useless for any other purpose or version.
 */
export const WRAP_PURPOSES = ['pair', 'rotate', 'recovery'] as const;
export type WrapPurpose = (typeof WRAP_PURPOSES)[number];
export const WRAP_INFO = 'sa-wrap-v1';
export const WRAPPED_ADK_BYTES = X25519_BYTES + NONCE_BYTES + ADK_BYTES + TAG_BYTES; // 92
export const CHAIN_BLOB_BYTES = NONCE_BYTES + ADK_BYTES + TAG_BYTES; // 60

function assertPurpose(purpose: string): asserts purpose is WrapPurpose {
  if (!(WRAP_PURPOSES as readonly string[]).includes(purpose)) throw invalid(`unknown wrap purpose ${purpose}`);
}

export function wrapAad(purpose: WrapPurpose, keyVersion: number): Bytes {
  assertPurpose(purpose);
  assertVersion(keyVersion);
  return utf8(`${purpose}|${keyVersion}`);
}

export function chainAad(keyVersion: number): Bytes {
  assertVersion(keyVersion);
  if (keyVersion < 2) throw invalid('a chain blob exists only for key_version >= 2');
  return utf8(`chain|${keyVersion}`);
}

async function wrapKey(shared: Uint8Array, senderPublic: Uint8Array, recipientPublic: Uint8Array): Promise<CryptoKey> {
  const base = await hkdfBase(shared);
  return hkdfAesKey(base, concatBytes(senderPublic, recipientPublic), WRAP_INFO);
}

export interface WrapOptions {
  /** The key whose public half leads the blob: the device key for pairing; a fresh ephemeral key otherwise. */
  senderKey?: X25519KeyPair;
  /** Fixed nonce for the shared test vectors only. @internal */
  nonce?: Uint8Array;
}

export async function wrapAdk(
  adkRaw: Uint8Array,
  recipientPublic: Uint8Array,
  purpose: WrapPurpose,
  keyVersion: number,
  options: WrapOptions = {},
): Promise<Bytes> {
  assertLength(adkRaw, ADK_BYTES, 'ADK');
  assertLength(recipientPublic, X25519_BYTES, 'recipient public key');
  const aad = wrapAad(purpose, keyVersion);
  const sender = options.senderKey ?? (await generateX25519());
  const nonce = options.nonce ?? randomBytes(NONCE_BYTES);
  const shared = await x25519SharedSecret(sender.privateKey, recipientPublic);
  try {
    const key = await wrapKey(shared, sender.publicKey, recipientPublic);
    return concatBytes(sender.publicKey, nonce, await gcmEncrypt(key, nonce, aad, adkRaw));
  } finally {
    zeroize(shared);
  }
}

/** The public key that leads a wrapped-ADK blob (the pairing sender's device key, or the ephemeral key). */
export function blobSenderPublicKey(blob: Uint8Array): Bytes {
  assertLength(blob, WRAPPED_ADK_BYTES, 'wrapped ADK blob');
  return blob.slice(0, X25519_BYTES);
}

export interface UnwrapOptions {
  /** Require the blob to be wrapped by this public key (pairing: the advertised `sender_public_key`). */
  expectedSender?: Uint8Array;
}

/** Recovers the raw ADK; throws `decrypt_failed` for another recipient, purpose, version, or tampering. */
export async function unwrapAdk(
  blob: Uint8Array,
  recipient: X25519KeyPair,
  purpose: WrapPurpose,
  keyVersion: number,
  options: UnwrapOptions = {},
): Promise<Bytes> {
  const aad = wrapAad(purpose, keyVersion);
  const senderPublic = blobSenderPublicKey(blob);
  if (options.expectedSender && !equalBytes(senderPublic, options.expectedSender)) {
    throw new CryptoError('untrusted_sender', 'blob was not wrapped by the expected sender key');
  }
  const nonce = blob.subarray(X25519_BYTES, X25519_BYTES + NONCE_BYTES);
  const shared = await x25519SharedSecret(recipient.privateKey, senderPublic);
  try {
    const key = await wrapKey(shared, senderPublic, recipient.publicKey);
    return await gcmDecrypt(key, nonce, aad, blob.subarray(X25519_BYTES + NONCE_BYTES));
  } finally {
    zeroize(shared);
  }
}

/** Chain blob for version v: ADK(v-1) under ADK(v), aad "chain|<v>"; blob = nonce || ct+tag. */
export async function wrapChain(
  adkRaw: Uint8Array,
  previousRaw: Uint8Array,
  keyVersion: number,
  options: Pick<WrapOptions, 'nonce'> = {},
): Promise<Bytes> {
  const aad = chainAad(keyVersion);
  assertLength(previousRaw, ADK_BYTES, 'previous ADK');
  const nonce = options.nonce ?? randomBytes(NONCE_BYTES);
  return concatBytes(nonce, await gcmEncrypt(await aesKey(adkRaw), nonce, aad, previousRaw));
}

/** ADK(v-1) from the chain blob of version v and ADK(v). */
export async function unwrapChain(blob: Uint8Array, adkRaw: Uint8Array, keyVersion: number): Promise<Bytes> {
  const aad = chainAad(keyVersion);
  assertLength(blob, CHAIN_BLOB_BYTES, 'chain blob');
  return gcmDecrypt(await aesKey(adkRaw), blob.subarray(0, NONCE_BYTES), aad, blob.subarray(NONCE_BYTES));
}
