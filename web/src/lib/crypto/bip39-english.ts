import WORDLIST from './bip39-english.txt?raw';

/**
 * The official BIP-39 English wordlist (2048 words). `bip39-english.txt` is a byte-for-byte copy of
 * https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt (SHA-256
 * 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda, asserted by recovery.test.ts).
 * Index i encodes the 11-bit value i. Kept as text so it stays verifiable against the published file.
 */
export const BIP39_ENGLISH: readonly string[] = Object.freeze(WORDLIST.trim().split('\n'));

/** Exact-match index of a normalized word. */
export const BIP39_INDEX: ReadonlyMap<string, number> = new Map(BIP39_ENGLISH.map((w, i) => [w, i]));
