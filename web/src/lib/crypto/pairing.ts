import { sha256 } from '@noble/hashes/sha2.js';
import { assertAdkMatchesVersion, verifySignatureChain, type ChainState } from './authenticity';
import { CryptoError, invalid } from './errors';
import { assertVersion, b64uDecode, b64uEncode, equalBytes, zeroize } from './encoding';
import type { KeyStore } from './store';
import { unwrapAdk, wrapAdk } from './wrap';
import { X25519_BYTES, generateX25519, type X25519KeyPair } from './x25519';

/**
 * Device pairing (PRD §7.5, contract §Keys "Pairing"). The new device creates an ephemeral keypair and
 * registers its public key with `POST /v1/keys/pairings`; an existing device of the same account fetches it
 * by code, wraps its newest ADK to it with its own device key (purpose `pair`), and uploads the blob; the
 * new device picks the blob up once and stores the ADK.
 *
 * The server is not trusted with keys, so the QR or pasted text carries a fingerprint of the ephemeral
 * public key next to the code ({@link pairingPayload}); the existing device refuses a key from the server
 * that does not match it, so a substituted key cannot receive the ADK.
 */
export interface PairingKeys {
  /** In memory only for the life of the pairing screen; never stored. */
  keyPair: X25519KeyPair;
  /** `ephemeral_public_key` for `POST /v1/keys/pairings`. */
  ephemeralPublicKey: string;
}

export async function createPairingKeys(): Promise<PairingKeys> {
  const keyPair = await generateX25519();
  return { keyPair, ephemeralPublicKey: b64uEncode(keyPair.publicKey) };
}

const PAYLOAD_PREFIX = 'sa1';
const FINGERPRINT_BYTES = 16;

/** base64url of the first 128 bits of SHA-256(ephemeral public key). */
export function pairingFingerprint(ephemeralPublicKey: string): string {
  const pub = b64uDecode(ephemeralPublicKey);
  if (pub.length !== X25519_BYTES) throw invalid('ephemeral public key must be 32 bytes');
  return b64uEncode(sha256(pub).subarray(0, FINGERPRINT_BYTES));
}

/** What the new device shows as QR and pasteable text: `sa1.<code>.<fingerprint>`. */
export function pairingPayload(code: string, ephemeralPublicKey: string): string {
  if (!code || /\s/.test(code)) throw invalid('pairing code is empty or has whitespace');
  return `${PAYLOAD_PREFIX}.${code}.${pairingFingerprint(ephemeralPublicKey)}`;
}

/** Parses scanned or pasted pairing text. Returns null when it is not a pairing payload. */
export function parsePairingPayload(text: string): { code: string; fingerprint: string } | null {
  const t = text.trim();
  const first = t.indexOf('.');
  const last = t.lastIndexOf('.');
  if (first < 0 || last <= first || t.slice(0, first) !== PAYLOAD_PREFIX) return null;
  const code = t.slice(first + 1, last);
  const fingerprint = t.slice(last + 1);
  try {
    if (!code || /\s/.test(code) || b64uDecode(fingerprint).length !== FINGERPRINT_BYTES) return null;
  } catch {
    return null;
  }
  return { code, fingerprint };
}

/** Body of `POST /v1/keys/pairings/by-code/{code}/wrap`. */
export interface PairingWrapRequest {
  key_version: number;
  sender_public_key: string;
  blob: string;
}

/**
 * Existing device: wraps the newest stored ADK (or `keyVersion`) to the new device's ephemeral key with this
 * device's wrapping key. `fingerprint` comes from the scanned payload and must match the key the server
 * returned for the code.
 */
export async function wrapForPairing(
  store: KeyStore,
  deviceKey: X25519KeyPair,
  ephemeralPublicKey: string,
  fingerprint: string,
  keyVersion?: number,
): Promise<PairingWrapRequest> {
  if (!equalBytes(b64uDecode(pairingFingerprint(ephemeralPublicKey)), b64uDecode(fingerprint))) {
    throw new CryptoError('untrusted_sender', 'pairing key does not match the scanned code');
  }
  const version = keyVersion ?? (await store.currentVersion());
  if (version === 0) throw new CryptoError('not_found', 'this device holds no ADK to share');
  const raw = await store.unwrapAdkRaw(version);
  try {
    const blob = await wrapAdk(raw, b64uDecode(ephemeralPublicKey), 'pair', version, { senderKey: deviceKey });
    return { key_version: version, sender_public_key: b64uEncode(deviceKey.publicKey), blob: b64uEncode(blob) };
  } finally {
    zeroize(raw);
  }
}

/** `GET /v1/keys/pairings/{id}` once `status` is `ready`. */
export interface PairingReady {
  key_version: number;
  sender_public_key: string;
  blob: string;
}

export interface AcceptPairingOptions {
  /** `devices[].public_key` from `GET /v1/keys`; when given, the sender must be one of them. */
  trustedSenderKeys?: readonly (string | null)[];
}

/**
 * New device: unwraps the blob with the ephemeral key, checks the sender, verifies the key, and stores the ADK.
 * Verification (contract A.6 "Pairing receive"): the received ADK(v) must derive `versions[v].verify_key` and every
 * rotation 2..v must be signed by the version before it (`chain` = `GET /v1/keys/chain`). This is not anchored to
 * anything the new device already knows, so a dishonest server could still present a whole fabricated account to a
 * brand-new device (docs/CLIPBOARD_PROTOCOL.md §1 limitation); it does stop a key that is not the account's.
 */
export async function acceptPairing(
  store: KeyStore,
  pairing: PairingKeys,
  ready: PairingReady,
  chain: ChainState,
  options: AcceptPairingOptions = {},
): Promise<number> {
  assertVersion(ready.key_version);
  const sender = b64uDecode(ready.sender_public_key);
  if (sender.length !== X25519_BYTES) throw invalid('sender_public_key must be 32 bytes');
  if (options.trustedSenderKeys && !options.trustedSenderKeys.includes(ready.sender_public_key)) {
    throw new CryptoError('untrusted_sender', 'pairing sender is not a device of this account');
  }
  const raw = await unwrapAdk(b64uDecode(ready.blob), pairing.keyPair, 'pair', ready.key_version, {
    expectedSender: sender,
  });
  try {
    await assertAdkMatchesVersion(raw, chain.versions, ready.key_version);
    verifySignatureChain(chain, ready.key_version);
    await store.saveAdk(ready.key_version, raw);
  } finally {
    zeroize(raw);
  }
  return ready.key_version;
}
