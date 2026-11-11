import { describe, expect, it } from 'vitest';
import { decodeClaims } from '../../lib/api/token';
import { safeReturnTo, withReturnTo } from './returnTo';
import { deriveKeyStatus, leftAccount, looksLikeEmail, nextAccountStep, passwordStrength, phaseOf } from './state';

const jwt = (payload: object) =>
  `eyJhbGciOiJFZERTQSJ9.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

describe('returnTo (only same-origin relative paths)', () => {
  it.each([
    ['/settings', '/settings'],
    ['/history?tab=sent#x', '/history?tab=sent#x'],
    ['/receive/abc', '/receive/abc'],
  ])('accepts %s', (raw, want) => expect(safeReturnTo(raw)).toBe(want));

  it.each([
    null,
    '',
    'settings',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    '/%0d%0aSet-Cookie',
    '/\u0000x',
    `/${'a'.repeat(600)}`,
    '/signin',
    '/signup?returnTo=/x',
    '/reset',
    '/account/key/setup',
    '/signin/choices',
  ])('rejects %s', (raw) => expect(safeReturnTo(raw)).toBe('/'));

  it('builds account links with the validated origin screen', () => {
    expect(withReturnTo('/signin', '/devices')).toBe('/signin?returnTo=%2Fdevices');
    expect(withReturnTo('/signin', '/')).toBe('/signin');
    expect(withReturnTo('/signin', '//evil')).toBe('/signin');
  });
});

describe('token claims (display state only)', () => {
  it('reads sub, acct and dl from the payload', () => {
    expect(decodeClaims(jwt({ sub: 'd1', acct: 'u1', dl: true }))).toEqual({ sub: 'd1', acct: 'u1', dl: true });
    expect(decodeClaims(jwt({ sub: 'd1' }))).toEqual({ sub: 'd1' });
    expect(decodeClaims(jwt({ sub: 'd1', acct: '', dl: 'yes' }))).toEqual({ sub: 'd1' });
    expect(decodeClaims('opaque-token')).toBeNull();
    expect(decodeClaims('a.!!!.c')).toBeNull();
  });
});

describe('account state machine', () => {
  it('derives the phase from the claims and the flag', () => {
    expect(phaseOf(null, true)).toBe('guest');
    expect(phaseOf({ sub: 'd' }, true)).toBe('guest');
    expect(phaseOf({ sub: 'd', acct: 'u' }, true)).toBe('signed_in');
    expect(phaseOf({ sub: 'd', acct: 'u' }, false)).toBe('guest');
  });

  it('derives the key state from the server and local versions', () => {
    expect(deriveKeyStatus(0, 0)).toBe('setup');
    expect(deriveKeyStatus(1, 0)).toBe('pair');
    expect(deriveKeyStatus(3, 2)).toBe('pair');
    expect(deriveKeyStatus(2, 2)).toBe('ready');
  });

  it('routes after the choices: not added → checklist, setup, pair, ready → checklist', () => {
    expect(nextAccountStep(false, 'none')).toBe('checklist');
    expect(nextAccountStep(true, 'setup')).toBe('setup');
    expect(nextAccountStep(true, 'pair')).toBe('pair');
    expect(nextAccountStep(true, 'ready')).toBe('checklist');
    expect(nextAccountStep(true, 'error')).toBe('checklist');
  });

  it('notices leaving the account (revoked, reset, expired) but not sign-in or add', () => {
    expect(leftAccount({ acct: 'u' }, { sub: 'd' })).toBe(true);
    expect(leftAccount({ acct: 'u' }, null)).toBe(true);
    expect(leftAccount({ acct: 'u' }, { acct: 'v' })).toBe(true);
    expect(leftAccount({ acct: 'u' }, { acct: 'u', dl: true })).toBe(false);
    expect(leftAccount({ sub: 'd' }, { acct: 'u' })).toBe(false);
    expect(leftAccount(null, null)).toBe(false);
  });

  it('rates passwords for the sign-up meter', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('short1')).toBe(1);
    expect(passwordStrength('aaaaaaaaaaaa')).toBe(1);
    expect(passwordStrength('lowercaseonly')).toBe(1);
    expect(passwordStrength('Lowercase12')).toBe(3);
    expect(passwordStrength('Granite-Lantern-Orbit-7')).toBe(4);
  });

  it('checks the email shape lightly', () => {
    expect(looksLikeEmail(' a@b.co ')).toBe(true);
    expect(looksLikeEmail('a@b')).toBe(false);
    expect(looksLikeEmail('a b@c.de')).toBe(false);
  });
});
