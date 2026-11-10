/**
 * Completed-block bitmap (docs/TRANSFER_PROTOCOL.md §4). Bit i is block i, least significant bit first:
 * block i is done when (bytes[i >> 3] >> (i & 7)) & 1. 20 GB / 4 MiB = 5120 blocks → 640 bytes.
 */
export class Bitmap {
  readonly size: number;
  readonly bytes: Uint8Array;
  private set_ = 0;

  constructor(size: number, bytes?: Uint8Array) {
    if (!Number.isInteger(size) || size < 0) throw new RangeError('bitmap size');
    this.size = size;
    const len = Math.ceil(size / 8);
    this.bytes = new Uint8Array(len);
    if (bytes) {
      if (bytes.byteLength !== len)
        throw new RangeError(`bitmap of ${size} blocks needs ${len} bytes, got ${bytes.byteLength}`);
      this.bytes.set(bytes);
      // Bits past the last block must be zero (they would claim blocks that do not exist).
      if (size % 8 && len && (this.bytes[len - 1] ?? 0) >> (size % 8))
        throw new RangeError('bits set past the last block');
      for (let i = 0; i < size; i++) if (this.has(i)) this.set_++;
    }
  }

  has(i: number): boolean {
    return i >= 0 && i < this.size && (((this.bytes[i >> 3] ?? 0) >> (i & 7)) & 1) === 1;
  }

  /** Marks block i; returns true when it was not already set. */
  set(i: number): boolean {
    if (i < 0 || i >= this.size) throw new RangeError(`block ${i} outside 0..${this.size - 1}`);
    if (this.has(i)) return false;
    this.bytes[i >> 3] = (this.bytes[i >> 3] ?? 0) | (1 << (i & 7));
    this.set_++;
    return true;
  }

  get count(): number {
    return this.set_;
  }

  get full(): boolean {
    return this.set_ === this.size;
  }

  /** Indices still missing, ascending (holes and out-of-order gaps included). */
  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.size; i++) if (!this.has(i)) out.push(i);
    return out;
  }

  /** Union with another bitmap of the same size. */
  merge(other: Bitmap): Bitmap {
    if (other.size !== this.size) throw new RangeError('bitmap sizes differ');
    const out = new Bitmap(this.size);
    for (let i = 0; i < this.bytes.length; i++) out.bytes[i] = (this.bytes[i] ?? 0) | (other.bytes[i] ?? 0);
    for (let i = 0; i < this.size; i++) if (out.has(i)) out.set_++;
    return out;
  }

  clone(): Bitmap {
    return new Bitmap(this.size, this.bytes);
  }
}
