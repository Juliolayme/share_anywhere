import { sha256 } from '@noble/hashes/sha2.js';
import { BIP39_ENGLISH, BIP39_INDEX } from './bip39-english';
import { CryptoError, invalid } from './errors';
import { randomBytes, zeroize, type Bytes } from './encoding';

/**
 * BIP-39 mnemonics over the English list (docs/CLIPBOARD_PROTOCOL.md §Keys "Recovery phrase"). The
 * recovery phrase is 12 words: 128 bits of entropy plus a 4-bit SHA-256 checksum. Only the wordlist and
 * checksum rules of BIP-39 are used; the BIP-39 PBKDF2 seed is not (Argon2id derives the key instead).
 */
export const RECOVERY_WORDS = 12;
export const RECOVERY_ENTROPY_BYTES = 16;

export type PhraseProblem = 'word_count' | 'unknown_word' | 'checksum';
export type PhraseCheck = { ok: true } | { ok: false; reason: PhraseProblem; word?: string };

/** NFKD, lower case, trimmed, single ASCII spaces: what the user typed becomes the Argon2id password. */
export function normalizePhrase(input: string): string {
  return input.normalize('NFKD').toLowerCase().trim().split(/\s+/u).filter(Boolean).join(' ');
}

function checksumBits(entropy: Uint8Array): number {
  return entropy.length / 4; // ENT / 32
}

/** BIP-39 encoding of 16, 20, 24, 28, or 32 bytes of entropy. */
export function entropyToPhrase(entropy: Uint8Array): string {
  if (entropy.length < 16 || entropy.length > 32 || entropy.length % 4 !== 0) {
    throw invalid('BIP-39 entropy must be 16-32 bytes in steps of 4');
  }
  const cs = checksumBits(entropy);
  const hash = sha256(entropy);
  let bits = '';
  for (const b of entropy) bits += b.toString(2).padStart(8, '0');
  bits += (hash[0] ?? 0).toString(2).padStart(8, '0').slice(0, cs);
  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) words.push(BIP39_ENGLISH[parseInt(bits.slice(i, i + 11), 2)] ?? '');
  return words.join(' ');
}

/** A fresh 12-word recovery phrase from 128 bits of CSPRNG entropy. */
export function generatePhrase(): string {
  const entropy = randomBytes(RECOVERY_ENTROPY_BYTES);
  try {
    return entropyToPhrase(entropy);
  } finally {
    zeroize(entropy);
  }
}

/** Entropy of any valid BIP-39 English phrase (12-24 words), or a typed reason it is not one. */
export function phraseToEntropy(input: string): Bytes {
  const words = normalizePhrase(input).split(' ');
  if (words.length < 12 || words.length > 24 || words.length % 3 !== 0) {
    throw new CryptoError('invalid_phrase', 'word_count');
  }
  let bits = '';
  for (const w of words) {
    const i = BIP39_INDEX.get(w);
    if (i === undefined) throw new CryptoError('invalid_phrase', 'unknown_word');
    bits += i.toString(2).padStart(11, '0');
  }
  const cs = words.length / 3;
  const entBits = bits.length - cs;
  const entropy = new Uint8Array(entBits / 8);
  for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const expected = (sha256(entropy)[0] ?? 0).toString(2).padStart(8, '0').slice(0, cs);
  if (bits.slice(entBits) !== expected) {
    zeroize(entropy);
    throw new CryptoError('invalid_phrase', 'checksum');
  }
  return entropy;
}

/** Checks a recovery phrase: exactly 12 known words with a valid checksum. */
export function checkRecoveryPhrase(input: string): PhraseCheck {
  const words = normalizePhrase(input).split(' ').filter(Boolean);
  if (words.length !== RECOVERY_WORDS) return { ok: false, reason: 'word_count' };
  const unknown = words.find((w) => !BIP39_INDEX.has(w));
  if (unknown !== undefined) return { ok: false, reason: 'unknown_word', word: unknown };
  try {
    zeroize(phraseToEntropy(words.join(' ')));
    return { ok: true };
  } catch {
    return { ok: false, reason: 'checksum' };
  }
}

export function isRecoveryPhrase(input: string): boolean {
  return checkRecoveryPhrase(input).ok;
}

/** Up to `limit` list words starting with `prefix` (autocomplete for the recovery entry screen). */
export function suggestWords(prefix: string, limit = 4): string[] {
  const p = normalizePhrase(prefix);
  if (!p || p.includes(' ')) return [];
  const out: string[] = [];
  for (const w of BIP39_ENGLISH) {
    if (w.startsWith(p)) out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}
