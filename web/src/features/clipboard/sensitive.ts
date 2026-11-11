// Best-effort "possibly sensitive" heuristics for Clipboard Sync (PRD §7.6, docs/CLIPBOARD_PROTOCOL.md §2.7).
// They run on the device before anything is encrypted or sent and never see the network. They are deliberately
// conservative and can miss secrets or flag harmless text: the UI says so, and a manual Sync can override a skip.

export type SensitiveKind = 'private_key' | 'jwt' | 'otp' | 'card' | 'api_key' | 'token' | 'password';

const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const JWT = /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
/** Well-known credential prefixes (cloud and source-hosting keys). */
const API_KEY =
  /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{32,})\b/;
const OTP = /^\d{4,8}$/;
const OTP_SPLIT = /^\d{3,4}[ -]\d{3,4}$/;
const CARD = /^(?:\d[ -]?){12,18}\d$/;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const k of counts.values()) {
    const p = k / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const classes = (s: string) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].reduce((n, re) => (re.test(s) ? n + 1 : n), 0);

/**
 * Returns why `text` looks sensitive, or null. Checked in order:
 * - a PEM private key block anywhere in the text;
 * - a JSON Web Token anywhere in the text;
 * - a well-known API key prefix anywhere in the text;
 * - the whole text is a one-time code: 4–8 digits, or two groups of 3–4 digits;
 * - the whole text is a payment card number (13–19 digits, Luhn-valid);
 * - the whole text is one long high-entropy token (24–512 characters, no spaces, not a URL);
 * - the whole text is one short password-like word (8–64 characters, no spaces, all four character classes).
 */
export function sensitiveKind(text: string): SensitiveKind | null {
  if (PEM_PRIVATE.test(text)) return 'private_key';
  if (JWT.test(text)) return 'jwt';
  if (API_KEY.test(text)) return 'api_key';
  const t = text.trim();
  if (OTP.test(t) || OTP_SPLIT.test(t)) return 'otp';
  if (CARD.test(t)) {
    const digits = t.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'card';
  }
  if (/\s/.test(t) || t.includes('://')) return null;
  const len = [...t].length;
  if (len >= 24 && len <= 512 && /^[A-Za-z0-9+/=_.~-]+$/.test(t)) {
    const hex = /^[0-9a-fA-F]+$/.test(t);
    if ((hex && len >= 32 && entropy(t) >= 3) || (!hex && classes(t) >= 3 && entropy(t) >= 4)) return 'token';
  }
  if (len >= 8 && len <= 64 && classes(t) === 4) return 'password';
  return null;
}
