/**
 * Claims of a device access token that the UI reads for display state only (docs/ADR/0010-account-sessions.md):
 * `acct` (account ID) and `dl` (device added). The server verifies the signature and decides access on every
 * request; nothing here is trusted for authorization.
 */
export interface TokenClaims {
  /** Device ID. */
  sub?: string;
  /** Account ID while this device has an account session. */
  acct?: string;
  /** True when the device is added to the account. */
  dl?: boolean;
}

/** Decodes the payload of a JWT without verifying it. Returns null for anything that is not a JWT. */
export function decodeClaims(token: string): TokenClaims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const raw = JSON.parse(json) as Record<string, unknown>;
    const claims: TokenClaims = {};
    if (typeof raw.sub === 'string') claims.sub = raw.sub;
    if (typeof raw.acct === 'string' && raw.acct) claims.acct = raw.acct;
    if (raw.dl === true) claims.dl = true;
    return claims;
  } catch {
    return null;
  }
}
