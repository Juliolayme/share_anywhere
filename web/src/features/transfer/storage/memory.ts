import type { Sink } from '../engine/receiver';

/** Above this size the in-memory fallback is refused (docs/phases/PHASE_3_WEB_P2P_TRANSFER.md). */
export const MEMORY_LIMIT = 256 * 1024 * 1024;

export interface MemorySink extends Sink {
  blob(type: string): Blob;
}

/** For browsers without OPFS (for example Firefox private windows), small files only; nothing survives a reload. */
export function memorySink(size: number): MemorySink {
  if (size > MEMORY_LIMIT)
    throw new DOMException('This file is too large to receive without browser storage.', 'QuotaExceededError');
  const bytes = new Uint8Array(size);
  return {
    write: async (offset, data) => void bytes.set(data, offset),
    read: async (offset, length) => bytes.slice(offset, offset + length),
    flush: async () => undefined,
    blob: (type) => new Blob([bytes], { type }),
  };
}
