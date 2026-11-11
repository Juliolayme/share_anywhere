/** Failure reasons of the key library (docs/CLIPBOARD_PROTOCOL.md §Keys). Callers branch on `code`, never on text. */
export type CryptoErrorCode =
  /** A length, version, purpose, or encoding is malformed. */
  | 'invalid_input'
  /** AES-GCM authentication failed: wrong key, wrong purpose or version (AAD), or tampered bytes. */
  | 'decrypt_failed'
  /** The recovery phrase has the wrong word count, an unknown word, or a bad checksum. */
  | 'invalid_phrase'
  /** A pairing blob was wrapped by a key that is not the advertised sender or a known device. */
  | 'untrusted_sender'
  /**
   * Key authenticity failed (docs/CLIPBOARD_PROTOCOL.md §1): a rotation blob whose chain link or verify key does not
   * check out, a pairing key that does not match the account's signed versions. Nothing was stored.
   */
  | 'unverified'
  /** Recovery: the phrase opened the blob, but the anchor or the signature chain does not verify. Nothing stored. */
  | 'recovery_unverified'
  /** The account's keys predate key authenticity (no verify key or anchor): they must be set up again. */
  | 'keys_legacy'
  /** The key store has no ADK for that version, or no device key. */
  | 'not_found'
  /** The key store already holds different bytes for that ADK version. */
  | 'adk_conflict'
  /** IndexedDB is missing or refuses to open (private mode, blocked site data, eviction). */
  | 'storage_unavailable'
  /** The runtime lacks a required primitive (WebCrypto, Workers). */
  | 'unsupported';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
    this.code = code;
  }
}

/** IndexedDB is unavailable; the UI explains that keys cannot be kept on this browser. */
export class KeyStoreUnavailableError extends CryptoError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('storage_unavailable', message, options);
    this.name = 'KeyStoreUnavailableError';
  }
}

export function invalid(message: string): CryptoError {
  return new CryptoError('invalid_input', message);
}
