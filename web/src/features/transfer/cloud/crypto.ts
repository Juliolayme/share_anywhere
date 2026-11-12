import {
  b64uDecode,
  b64uEncode,
  concatBytes,
  copyBytes,
  randomBytes,
  utf8,
  zeroize,
  type Bytes,
} from '../../../lib/crypto/encoding';
import { NONCE_BYTES, TAG_BYTES, aesKey, gcmDecrypt, gcmEncrypt, hkdfBytes } from '../../../lib/crypto/primitives';
import { generateX25519, x25519SharedSecret, type X25519KeyPair } from '../../../lib/crypto/x25519';

/**
 * Cloud Distribution crypto (docs/TRANSFER_PROTOCOL.md §9), byte for byte with Android and iOS through
 * `shared/protocol/schemas/cloud-vectors.json`: AES-256-GCM parts bound to their object, position and count, and the
 * per-file key wrapped to a receiver's ephemeral X25519 key.
 */
export const PART_OVERHEAD = NONCE_BYTES + TAG_BYTES; // 28
export const FILE_KEY_BYTES = 32;

export const partAad = (objectId: string, n: number, count: number): Bytes =>
  utf8(`sa-cloud-v1|${objectId}|${n}|${count}`);

export function newFileKey(): Bytes {
  return randomBytes(FILE_KEY_BYTES);
}

/** Stored part: nonce || ciphertext || tag. */
export async function sealPart(
  key: Uint8Array,
  objectId: string,
  n: number,
  count: number,
  plaintext: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): Promise<Bytes> {
  const k = await aesKey(key);
  return concatBytes(nonce, await gcmEncrypt(k, nonce, partAad(objectId, n, count), plaintext));
}

/** Opens a stored part; throws CryptoError('decrypt_failed') when it was altered, moved or truncated. */
export async function openPart(
  key: Uint8Array,
  objectId: string,
  n: number,
  count: number,
  stored: Uint8Array,
): Promise<Bytes> {
  const k = await aesKey(key);
  return gcmDecrypt(k, stored.subarray(0, NONCE_BYTES), partAad(objectId, n, count), stored.subarray(NONCE_BYTES));
}

export interface ObjectKey {
  objectId: string;
  fileId: string;
  key: Bytes;
  /** SHA-256 of the whole plaintext file (32 bytes). */
  sha256: Bytes;
}

export interface WrappedKey {
  object_id: string;
  file_id: string;
  nonce: string;
  wrapped: string;
}

export interface CloudKeyPayload {
  public_key: string;
  keys: WrappedKey[];
}

const wrapInfo = (sessionId: string, receiverPid: string) => `sa-cloud-key-v1|${sessionId}|${receiverPid}`;
const wrapAad = (objectId: string, fileId: string) => utf8(`sa-cloud-wrap-v1|${objectId}|${fileId}`);

async function wrapKeyBytes(
  mine: X25519KeyPair,
  peerPublic: Uint8Array,
  senderPublic: Uint8Array,
  receiverPublic: Uint8Array,
  sessionId: string,
  receiverPid: string,
): Promise<Bytes> {
  const shared = await x25519SharedSecret(mine.privateKey, peerPublic);
  try {
    return await hkdfBytes(shared, concatBytes(senderPublic, receiverPublic), wrapInfo(sessionId, receiverPid));
  } finally {
    zeroize(shared);
  }
}

/** The sender's CLOUD_KEY answer to a receiver's CLOUD_KEY_REQUEST. */
export async function wrapKeys(
  keys: ObjectKey[],
  receiverPublicB64u: string,
  sessionId: string,
  receiverPid: string,
  options: { sender?: X25519KeyPair; nonces?: Uint8Array[] } = {},
): Promise<CloudKeyPayload> {
  const receiverPublic = b64uDecode(receiverPublicB64u);
  const sender = options.sender ?? (await generateX25519());
  const raw = await wrapKeyBytes(sender, receiverPublic, sender.publicKey, receiverPublic, sessionId, receiverPid);
  try {
    const k = await aesKey(raw);
    const out: WrappedKey[] = [];
    for (const [i, o] of keys.entries()) {
      const nonce = options.nonces?.[i] ?? randomBytes(NONCE_BYTES);
      const wrapped = await gcmEncrypt(k, nonce, wrapAad(o.objectId, o.fileId), concatBytes(o.key, o.sha256));
      out.push({ object_id: o.objectId, file_id: o.fileId, nonce: b64uEncode(nonce), wrapped: b64uEncode(wrapped) });
    }
    return { public_key: b64uEncode(sender.publicKey), keys: out };
  } finally {
    zeroize(raw);
  }
}

/** The receiver unwraps a CLOUD_KEY answer with its ephemeral key; entries that fail authentication are skipped. */
export async function unwrapKeys(
  payload: CloudKeyPayload,
  receiver: X25519KeyPair,
  sessionId: string,
  receiverPid: string,
): Promise<ObjectKey[]> {
  const senderPublic = b64uDecode(payload.public_key);
  const raw = await wrapKeyBytes(receiver, senderPublic, senderPublic, receiver.publicKey, sessionId, receiverPid);
  try {
    const k = await aesKey(raw);
    const out: ObjectKey[] = [];
    for (const w of payload.keys) {
      try {
        const plain = await gcmDecrypt(k, b64uDecode(w.nonce), wrapAad(w.object_id, w.file_id), b64uDecode(w.wrapped));
        if (plain.length !== FILE_KEY_BYTES + 32) continue;
        out.push({
          objectId: w.object_id,
          fileId: w.file_id,
          key: copyBytes(plain.subarray(0, 32)),
          sha256: copyBytes(plain.subarray(32)),
        });
      } catch {
        /* a key for another receiver or altered in transit */
      }
    }
    return out;
  } finally {
    zeroize(raw);
  }
}
