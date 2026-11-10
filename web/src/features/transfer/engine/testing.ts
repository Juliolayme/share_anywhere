/** In-memory channel pair and sink for engine tests (not imported by the app). */
import type { Channel } from './channel';
import type { Sink } from './receiver';

class MemChannel implements Channel {
  peer!: MemChannel;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: (() => void) | null = null;
  onmessage: ((data: ArrayBuffer) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState: Channel['readyState'] = 'open';
  sent = 0;
  constructor(readonly maxMessageSize: number) {}

  send(data: ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('channel closed');
    if (data.byteLength > this.maxMessageSize) throw new Error(`message of ${data.byteLength} bytes over the limit`);
    this.sent++;
    this.bufferedAmount += data.byteLength;
    const copy = data.slice(0);
    // Deliver asynchronously, in order, like SCTP ordered reliable delivery.
    queueMicrotask(() => {
      this.bufferedAmount -= data.byteLength;
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
      if (this.peer.readyState !== 'closed') this.peer.onmessage?.(copy);
    });
  }

  close(): void {
    if (this.readyState !== 'open') return;
    this.readyState = 'closing';
    // Messages already queued are delivered first (microtasks run in order), then both ends close.
    queueMicrotask(() => {
      this.readyState = 'closed';
      this.peer.readyState = 'closed';
      this.onclose?.();
      this.peer.onclose?.();
    });
  }
}

export function channelPair(maxMessageSize = 65536): [Channel & { sent: number }, Channel & { sent: number }] {
  const a = new MemChannel(maxMessageSize);
  const b = new MemChannel(maxMessageSize);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export class MemorySink implements Sink {
  bytes: Uint8Array;
  writes = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }
  async write(offset: number, data: Uint8Array): Promise<void> {
    this.writes++;
    this.bytes.set(data, offset);
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes.slice(offset, offset + length);
  }
  async flush(): Promise<void> {}
}

/** Deterministic pseudo-random bytes (xorshift) so tests do not depend on crypto RNG speed. */
export function bytesOf(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function until(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 1);
    };
    tick();
  });
}
