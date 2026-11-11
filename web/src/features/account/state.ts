import type { TokenClaims } from '../../lib/api/token';

/**
 * Account state on this device (docs/UX_SCREEN_MAP.md §7–§9, PRD §2 "Signing in"):
 * - `guest`: no account session (or the `accounts` flag is off);
 * - `signed_in` with `added: false`: a short (24 h) account session, sees `product.add_device_clipboard`;
 * - `signed_in` with `added: true`: the key state decides what account features can do.
 */
export type Phase = 'guest' | 'signed_in';

/**
 * Account Data Key state of an added device (PRD §7.5):
 * - `setup`: the account has no ADK yet (key_version 0): this is the first device, AC-5;
 * - `pair`: the account has an ADK this device does not hold: AC-6 (pair or recovery phrase);
 * - `ready`: the device holds the account's newest ADK;
 * - `unavailable`: this browser cannot keep keys (IndexedDB or WebCrypto missing);
 * - `error`: the check failed (offline, server error); retried on the next refresh;
 * - `rejected`: a key change (rotation) addressed to this device did not verify, or the server refused this device's
 *   key proof (docs/CLIPBOARD_PROTOCOL.md §1 "Key authenticity"): nothing was stored; pair again or use the phrase;
 * - `legacy`: the account's keys predate key authenticity (`409 keys_legacy`, pre-release data): set up again.
 */
export type KeyStatus =
  'none' | 'checking' | 'setup' | 'pair' | 'ready' | 'unavailable' | 'error' | 'rejected' | 'legacy';

export function phaseOf(claims: TokenClaims | null, enabled: boolean): Phase {
  return enabled && claims?.acct ? 'signed_in' : 'guest';
}

/** Key state from the server's newest version and the newest version stored on this device. */
export function deriveKeyStatus(serverVersion: number, localVersion: number): KeyStatus {
  if (serverVersion <= 0) return 'setup';
  return localVersion >= serverVersion ? 'ready' : 'pair';
}

/** True when an account session ended without this tab signing out (revoked elsewhere, reset, expired). */
export function leftAccount(prev: TokenClaims | null, next: TokenClaims | null): boolean {
  return !!prev?.acct && prev.acct !== next?.acct;
}

/** The screen that follows the after-sign-in choices or a finished key step. */
export function nextAccountStep(added: boolean, keys: KeyStatus): 'setup' | 'pair' | 'checklist' {
  if (!added) return 'checklist';
  if (keys === 'setup') return 'setup';
  if (keys === 'pair' || keys === 'rejected') return 'pair';
  return 'checklist';
}

/** Password strength for the sign-up meter (design `signup`): 0–4 bars. The server enforces the policy. */
export function passwordStrength(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes >= 2) score++;
  if (classes >= 3 && pw.length >= 10) score++;
  if (/^(.)\1*$/.test(pw)) score = 0;
  return Math.min(4, Math.max(pw.length < 10 ? 1 : score, 1)) as 1 | 2 | 3 | 4;
}

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 128;

/** Light client-side email check (the server normalizes and validates). */
export function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}
