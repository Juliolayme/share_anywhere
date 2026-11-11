// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { entropy, sensitiveKind } from './sensitive';

describe('sensitive-content heuristics (best-effort, docs/CLIPBOARD_PROTOCOL.md §2.7)', () => {
  it('flags one-time codes: 4–8 digits alone, or two short digit groups', () => {
    for (const t of ['4829', '482913', ' 48291375 ', '482 913', '4829-1375']) expect(sensitiveKind(t)).toBe('otp');
    for (const t of ['123', '123456789', 'Code 482913 expires soon', '48 29']) expect(sensitiveKind(t)).not.toBe('otp');
  });

  it('flags JSON Web Tokens alone or inside text', () => {
    // Test fixtures are assembled at runtime so secret scanners never see a token-shaped literal in the source.
    const jwt = [
      ['ey', 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join(''),
      ['ey', 'JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ'].join(''),
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    expect(sensitiveKind(jwt)).toBe('jwt');
    expect(sensitiveKind(`Authorization: Bearer ${jwt}`)).toBe('jwt');
  });

  it('flags PEM private key blocks (RSA, EC, OpenSSH, PKCS#8, PGP) but not certificates or public keys', () => {
    for (const label of [
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
    ])
      expect(sensitiveKind(`notes\n-----BEGIN ${label}-----\nMIIEow...\n-----END ${label}-----`)).toBe('private_key');
    const begin = (label: string) => ['-----', 'BEGIN ', label, '-----'].join('');
    expect(sensitiveKind(`${begin('PGP PRIVATE KEY BLOCK')}\nlQOYBF...`)).toBe('private_key');
    expect(sensitiveKind(`${begin('CERTIFICATE')}\nMIIB...\n-----END CERTIFICATE-----`)).toBeNull();
    expect(sensitiveKind(`${begin('PUBLIC KEY')}\nMFkw...`)).toBeNull();
  });

  it('flags well-known API key shapes', () => {
    expect(sensitiveKind(['AKIA', 'IOSFODNN7EXAMPLE'].join(''))).toBe('api_key');
    expect(sensitiveKind(`token ${['gh', 'p_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'].join('')} here`)).toBe(
      'api_key',
    );
    expect(sensitiveKind(['sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc'].join(''))).toBe('api_key');
  });

  it('flags long high-entropy tokens, not ordinary long words, URLs or sentences', () => {
    expect(sensitiveKind('Zx9qL2mN8vB4tR7wK1pS6dF3hJ5gY0cE')).toBe('token');
    expect(sensitiveKind('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe('token');
    expect(sensitiveKind('internationalization-and-localization')).toBeNull();
    expect(sensitiveKind('https://example.com/a/very/long/path?query=Zx9qL2mN8vB4tR7wK1pS6dF3')).toBeNull();
    expect(sensitiveKind('Order #A-5531 ships Thursday — tracking VN829104455. Pick up at Hub D7.')).toBeNull();
    expect(entropy('aaaa')).toBe(0);
    expect(entropy('abcd')).toBe(2);
  });

  it('flags Luhn-valid card numbers only', () => {
    expect(sensitiveKind('4111 1111 1111 1111')).toBe('card');
    expect(sensitiveKind('5500-0000-0000-0004')).toBe('card');
    expect(sensitiveKind('4111 1111 1111 1112')).toBeNull();
  });

  it('flags short password-like words that mix all four character classes', () => {
    expect(sensitiveKind('Tr0ub4dor&3')).toBe('password');
    expect(sensitiveKind('hello-world')).toBeNull();
    expect(sensitiveKind('Meeting at 10:30!')).toBeNull();
  });

  it('leaves ordinary text alone', () => {
    for (const t of [
      'Draft reply: Thanks — I’ll send the files tonight via Share Anywhere.',
      'Tiếng Việt có dấu, không phải bí mật.',
      'https://share-anywhere.example/j/abc',
      'Call me at 0901 234 567 tomorrow',
      'e2e clipboard marker 1731300000',
    ])
      expect(sensitiveKind(t)).toBeNull();
  });
});
