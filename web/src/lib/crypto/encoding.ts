import { invalid } from './errors';

/** Bytes typed for WebCrypto (`BufferSource` wants an ArrayBuffer-backed view). */
export type Bytes = Uint8Array<ArrayBuffer>;

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64U_INDEX = new Map([...B64U].map((c, i) => [c, i]));

/** Base64url without padding, the encoding of every binary field on the wire (contract §Keys). */
export function b64uEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64U.charAt((n >> 18) & 63) + B64U.charAt((n >> 12) & 63) + B64U.charAt((n >> 6) & 63) + B64U.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = ((bytes[i] ?? 0) << 16) | (rest === 2 ? (bytes[i + 1] ?? 0) << 8 : 0);
    out += B64U.charAt((n >> 18) & 63) + B64U.charAt((n >> 12) & 63);
    if (rest === 2) out += B64U.charAt((n >> 6) & 63);
  }
  return out;
}

/** Strict base64url decoder: rejects padding, other alphabets, impossible lengths, and non-zero spare bits. */
export function b64uDecode(text: string): Bytes {
  if (text.length % 4 === 1) throw invalid('base64url: impossible length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    const v = B64U_INDEX.get(c);
    if (v === undefined) throw invalid('base64url: invalid character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw invalid('base64url: non-canonical encoding');
  return out;
}

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(text: string): Bytes {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(text)) throw invalid('hex: malformed');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A fresh ArrayBuffer-backed copy (WebCrypto inputs; also detaches callers from shared buffers). */
export function copyBytes(bytes: Uint8Array): Bytes {
  return Uint8Array.from(bytes);
}

/** Constant-time comparison for equal-length inputs. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Best-effort erase of transient key material once a caller is done with it. */
export function zeroize(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const b of buffers) b?.fill(0);
}

export function assertLength(bytes: Uint8Array, n: number, what: string): void {
  if (bytes.length !== n) throw invalid(`${what} must be ${n} bytes, got ${bytes.length}`);
}

export function assertVersion(version: number, what = 'key_version'): void {
  if (!Number.isSafeInteger(version) || version < 1) throw invalid(`${what} must be a positive integer`);
}
