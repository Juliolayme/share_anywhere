import { randomBytes } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import type { APIRequestContext } from '@playwright/test';
import { deviceKeyProof } from '../../src/lib/crypto/authenticity';
import { b64uDecode } from '../../src/lib/crypto/encoding';
import { unwrapAdk } from '../../src/lib/crypto/wrap';
import { x25519FromSecret } from '../../src/lib/crypto/x25519';
import { BASE } from '../pairing/helpers';

// Test-side key material for the key authenticity specs (docs/TESTING_AND_CI.md §3): the spec plays someone who
// kept an old Account Data Key (the recovery phrase opens whatever version is current when it runs), using the
// app's own crypto library in Node (the modules that need no Vite asset imports; the recovery seed follows
// docs/CLIPBOARD_PROTOCOL.md §1: Argon2id over the NFKD-normalized phrase). Nothing here is used by the app.

interface RecoveryBlob {
  key_version: number;
  recovery_blob: string;
  salt: string;
  params: { m: number; t: number; p: number };
}

/** The account's current ADK, opened with the recovery phrase (`GET /v1/keys/recovery` with `authorization`). */
export async function adkFromPhrase(
  request: APIRequestContext,
  authorization: string,
  phrase: string,
): Promise<{ keyVersion: number; adk: Uint8Array }> {
  const res = await request.get(`${BASE}/v1/keys/recovery`, { headers: { Authorization: authorization } });
  if (!res.ok()) throw new Error(`GET /v1/keys/recovery: ${res.status()}`);
  const rec = (await res.json()) as RecoveryBlob;
  const normalized = phrase.normalize('NFKD').toLowerCase().trim().split(/\s+/u).join(' ');
  const { m, t, p } = rec.params;
  const seed = await argon2idAsync(new TextEncoder().encode(normalized), b64uDecode(rec.salt), { m, t, p, dkLen: 32 });
  const keyPair = await x25519FromSecret(Uint8Array.from(seed));
  const adk = await unwrapAdk(b64uDecode(rec.recovery_blob), keyPair, 'recovery', rec.key_version);
  return { keyVersion: rec.key_version, adk };
}

/** A `PUT /v1/keys/device` body for `deviceId` with a genuine proof by ADK `keyVersion` (any wrapping key). */
export function proofBy(adk: Uint8Array, keyVersion: number, deviceId: string) {
  return deviceKeyProof(adk, keyVersion, deviceId, new Uint8Array(randomBytes(32)));
}
