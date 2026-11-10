import { sha256 } from '@noble/hashes/sha2.js';

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}

/** SHA-256 of one block with WebCrypto (fast, native). */
export async function digest(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await digest(new TextEncoder().encode(text)));
}

/**
 * Whole-file SHA-256 fed strictly in order. WebCrypto has no streaming digest, so this uses the audited
 * @noble/hashes implementation; it never holds more than the chunk it is given.
 */
export class StreamHasher {
  private h = sha256.create();
  private pos = 0;

  get position(): number {
    return this.pos;
  }

  /** Feeds bytes that start at `offset`; ignores ranges already hashed and refuses gaps. */
  update(offset: number, data: Uint8Array): boolean {
    if (offset > this.pos) return false; // a gap: caller must fill it in order
    const skip = this.pos - offset;
    if (skip >= data.byteLength) return true;
    this.h.update(skip ? data.subarray(skip) : data);
    this.pos += data.byteLength - skip;
    return true;
  }

  hex(): string {
    return hex(this.h.digest());
  }
}

/** Hashes `size` bytes read through `read`, in chunks, reporting progress. */
export async function hashStream(
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  onProgress?: (done: number) => void,
  chunk = 4 * 1024 * 1024,
): Promise<string> {
  const h = new StreamHasher();
  for (let off = 0; off < size; off += chunk) {
    const data = await read(off, Math.min(chunk, size - off));
    h.update(off, data);
    onProgress?.(off + data.byteLength);
  }
  return h.hex();
}
