// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BIP39_ENGLISH } from './bip39-english';
import { fromHex, hex } from './encoding';
import {
  RECOVERY_PARAMS,
  checkRecoveryPhrase,
  deriveRecoveryKeyPair,
  deriveRecoverySeed,
  entropyToPhrase,
  generatePhrase,
  generateRecoverySalt,
  isRecoveryPhrase,
  normalizePhrase,
  phraseToEntropy,
  recoverySeed,
  suggestWords,
} from './recovery';

// Trezor reference vectors (github.com/trezor/python-mnemonic vectors.json, English).
const BIP39_VECTORS: [string, string][] = [
  [
    '00000000000000000000000000000000',
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
  [
    '80808080808080808080808080808080',
    'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  ],
  ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
  ['9e885d952ad362caeb4efe34a8e91bd2', 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic'],
  ['c0ba5a8e914111210f2bd131f3d5e08d', 'scheme spot photo card baby mountain device kick cradle pact join borrow'],
  ['23db8160a31d3e0dca3688ed941adbf3', 'cat swing flag economy stadium alone churn speed unique patch report train'],
  [
    'f30f8c1da665478f49b001d94c5fc452',
    'vessel ladder alter error federal sibling chat ability sun glass valve picture',
  ],
  [
    '000000000000000000000000000000000000000000000000',
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent',
  ],
  [
    '8080808080808080808080808080808080808080808080808080808080808080',
    'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless',
  ],
];

const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SALT = fromHex('909192939495969798999a9b9c9d9e9f');

describe('BIP-39 wordlist', () => {
  it('is the official English list', () => {
    const file = readFileSync(new URL('./bip39-english.txt', import.meta.url));
    expect(createHash('sha256').update(file).digest('hex')).toBe(
      '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda',
    );
    expect(BIP39_ENGLISH).toHaveLength(2048);
    expect(new Set(BIP39_ENGLISH).size).toBe(2048);
    expect([BIP39_ENGLISH[0], BIP39_ENGLISH[2047]]).toEqual(['abandon', 'zoo']);
  });
});

describe('recovery phrase', () => {
  it('encodes and decodes the reference vectors', () => {
    for (const [entropy, words] of BIP39_VECTORS) {
      expect(entropyToPhrase(fromHex(entropy))).toBe(words);
      expect(hex(phraseToEntropy(words))).toBe(entropy);
    }
  });

  it('generates valid, distinct 12-word phrases', () => {
    const a = generatePhrase();
    const b = generatePhrase();
    expect(a.split(' ')).toHaveLength(12);
    expect(a).not.toBe(b);
    expect(isRecoveryPhrase(a)).toBe(true);
    expect(phraseToEntropy(a)).toHaveLength(16);
  });

  it('validates word count, words, and the checksum', () => {
    expect(checkRecoveryPhrase(LEGAL)).toEqual({ ok: true });
    expect(checkRecoveryPhrase(LEGAL.replace(/ yellow$/, ' year'))).toEqual({ ok: false, reason: 'checksum' });
    expect(checkRecoveryPhrase(LEGAL.replace(/^legal/, 'legel'))).toEqual({
      ok: false,
      reason: 'unknown_word',
      word: 'legel',
    });
    expect(checkRecoveryPhrase(LEGAL.split(' ').slice(0, 11).join(' '))).toEqual({ ok: false, reason: 'word_count' });
    expect(checkRecoveryPhrase(BIP39_VECTORS[8]?.[1] ?? '')).toEqual({ ok: false, reason: 'word_count' });
    expect(checkRecoveryPhrase('')).toEqual({ ok: false, reason: 'word_count' });
    expect(() => phraseToEntropy('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo')).toThrow(/checksum/);
  });

  it('normalizes case, spacing, and Unicode compatibility forms', () => {
    expect(normalizePhrase(`  LEGAL\twinner\n\nThank\u3000year  `)).toBe('legal winner thank year');
    expect(normalizePhrase('ｌｅｇａｌ ｗｉｎｎｅｒ')).toBe('legal winner'); // full-width letters (NFKD)
    expect(isRecoveryPhrase(`  ${LEGAL.toUpperCase().replace(/ /g, '   ')} `)).toBe(true);
  });

  it('suggests list words for a prefix', () => {
    expect(suggestWords('ab')).toEqual(['abandon', 'ability', 'able', 'about']);
    expect(suggestWords('zoo')).toEqual(['zoo']);
    expect(suggestWords('')).toEqual([]);
  });
});

describe('Argon2id recovery key', () => {
  it('derives the vector seed and X25519 keypair from a typed phrase (m=65536 KiB, t=3, p=1)', async () => {
    const typed = `  ${LEGAL.toUpperCase()}  `;
    const seed = await deriveRecoverySeed(typed, SALT, RECOVERY_PARAMS);
    expect(hex(seed)).toBe('db0713f9d04aa176dbb28bbf0e7a793267581485b23fd2a096ba256e5320762d');
    const pair = await deriveRecoveryKeyPair(LEGAL, SALT);
    expect(hex(pair.publicKey)).toBe('49527d10263430fa651486e62bb2c824ed83cac83d1f7bb3c63f344faa17416c');
    if (pair.privateKey.kind === 'webcrypto') expect(pair.privateKey.key.extractable).toBe(false);
  }, 30_000);

  it('rejects invalid phrases, weak or oversized parameters, and bad salts before hashing', async () => {
    expect(() => recoverySeed('zoo zoo zoo', SALT)).toThrow(/word_count/);
    expect(() => recoverySeed(LEGAL, SALT, { m: 8, t: 3, p: 1 })).toThrow(/m must be/);
    expect(() => recoverySeed(LEGAL, SALT, { m: 65536, t: 1, p: 1 })).toThrow(/t must be/);
    expect(() => recoverySeed(LEGAL, SALT, { m: 1 << 30, t: 3, p: 1 })).toThrow(/m must be/);
    expect(() => recoverySeed(LEGAL, new Uint8Array(8))).toThrow(/salt/);
    expect(generateRecoverySalt()).toHaveLength(16);
    const ac = new AbortController();
    ac.abort();
    await expect(deriveRecoverySeed(LEGAL, SALT, RECOVERY_PARAMS, { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
