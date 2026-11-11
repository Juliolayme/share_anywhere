import { CryptoError, invalid } from './errors';
import { assertLength, assertVersion, b64uDecode, b64uEncode, randomBytes, utf8, type Bytes } from './encoding';
import { NONCE_BYTES, gcmDecrypt, gcmEncrypt } from './primitives';

export { b64uDecode, b64uEncode } from './encoding';

/**
 * Per-item encryption (PRD §7.5): AES-256-GCM under the `history-v1` or `clipboard-v1` subkey of ADK
 * `key_version`, random 12-byte nonce, AAD = UTF-8(`<id>|<key_version>`) where id is the history
 * `entry_id` or the clipboard `event_id`. The AAD binds a ciphertext to its row and key version, so the
 * server cannot move it to another entry or relabel its version.
 */
export interface EncryptedItem {
  nonce: Bytes;
  ciphertext: Bytes;
}

/** The wire shape of `nonce` and `ciphertext` (base64url without padding). */
export interface EncryptedItemWire {
  nonce: string;
  ciphertext: string;
}

export function itemAad(id: string, keyVersion: number): Bytes {
  if (!id || id.includes('|')) throw invalid('item id must be non-empty and must not contain "|"');
  assertVersion(keyVersion);
  return utf8(`${id}|${keyVersion}`);
}

export async function encryptItem(
  subkey: CryptoKey,
  id: string,
  keyVersion: number,
  plaintext: Uint8Array | string,
): Promise<EncryptedItem> {
  return encryptItemWithNonce(subkey, id, keyVersion, plaintext, randomBytes(NONCE_BYTES));
}

/**
 * Deterministic variant for the shared test vectors only. Reusing a nonce under one key breaks AES-GCM;
 * production code calls {@link encryptItem}, which draws a fresh random nonce every time.
 * @internal
 */
export async function encryptItemWithNonce(
  subkey: CryptoKey,
  id: string,
  keyVersion: number,
  plaintext: Uint8Array | string,
  nonce: Uint8Array,
): Promise<EncryptedItem> {
  const aad = itemAad(id, keyVersion);
  assertLength(nonce, NONCE_BYTES, 'nonce');
  const data = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
  return { nonce: Uint8Array.from(nonce), ciphertext: await gcmEncrypt(subkey, nonce, aad, data) };
}

/** Throws `CryptoError('decrypt_failed')` on a wrong key, id, version, or any tampered byte. */
export async function decryptItem(
  subkey: CryptoKey,
  id: string,
  keyVersion: number,
  item: EncryptedItem,
): Promise<Bytes> {
  return gcmDecrypt(subkey, item.nonce, itemAad(id, keyVersion), item.ciphertext);
}

export async function decryptItemText(
  subkey: CryptoKey,
  id: string,
  keyVersion: number,
  item: EncryptedItem,
): Promise<string> {
  const bytes = await decryptItem(subkey, id, keyVersion, item);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new CryptoError('decrypt_failed', 'plaintext is not UTF-8', { cause });
  }
}

export function itemToWire(item: EncryptedItem): EncryptedItemWire {
  return { nonce: b64uEncode(item.nonce), ciphertext: b64uEncode(item.ciphertext) };
}

export function itemFromWire(wire: EncryptedItemWire): EncryptedItem {
  const nonce = b64uDecode(wire.nonce);
  assertLength(nonce, NONCE_BYTES, 'nonce');
  return { nonce, ciphertext: b64uDecode(wire.ciphertext) };
}
