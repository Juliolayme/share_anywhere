/**
 * Account key library (docs/CLIPBOARD_PROTOCOL.md §Keys). Import it lazily (`await import('../lib/crypto')`)
 * from account screens so the main bundle stays within its budget.
 */
export {
  ADK_BYTES,
  FIRST_KEY_VERSION,
  SUBKEY_INFO,
  SUBKEY_PURPOSES,
  deriveSubkey,
  generateAdk,
  type Adk,
  type SubkeyPurpose,
} from './adk';
export * from './bootstrap';
export * from './device-key';
export { CryptoError, KeyStoreUnavailableError, type CryptoErrorCode } from './errors';
export { b64uDecode, b64uEncode, zeroize, type Bytes } from './encoding';
export {
  decryptItem,
  decryptItemText,
  encryptItem,
  itemAad,
  itemFromWire,
  itemToWire,
  type EncryptedItem,
  type EncryptedItemWire,
} from './item';
export * from './pairing';
export * from './recovery';
export * from './rotation';
export { KEY_DB_NAME, KeyStore, openKeyStore, requestPersistentStorage, type KeyStoreOptions } from './store';
export {
  WRAP_PURPOSES,
  blobSenderPublicKey,
  unwrapAdk,
  unwrapChain,
  wrapAdk,
  wrapChain,
  type WrapPurpose,
} from './wrap';
export {
  generateX25519,
  hasWebCryptoX25519,
  x25519FromSecret,
  type X25519KeyPair,
  type X25519PrivateKey,
} from './x25519';
