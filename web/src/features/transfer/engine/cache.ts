import { BLOCK_SIZE } from './frame';
import { digest } from './hash';

/** A block read from disk with its SHA-256, shared by every receiver's connection. Never mutate `data`. */
export interface CachedBlock {
  data: Uint8Array;
  sum: Uint8Array;
}

/**
 * Sender-side block cache shared by the connections to all receivers of a session (docs/TRANSFER_PROTOCOL.md
 * §5.1): least recently used blocks are evicted once the cache holds more than `maxBytes`, and concurrent
 * requests for the same block share one read and one hash. Receivers that are close together read the file
 * once; a receiver that falls far behind reads its blocks again rather than holding memory for everyone.
 * Each connection awaits only its own blocks, so a slow receiver never stalls the others.
 */
export class BlockCache {
  private entries = new Map<string, CachedBlock>(); // Map order is the LRU order (oldest first)
  private pending = new Map<string, Promise<CachedBlock>>();
  private held = 0;
  readonly stats = { reads: 0, hits: 0, evictions: 0 };

  constructor(readonly maxBytes: number) {}

  /** Bytes currently held (never above `maxBytes`). */
  get bytes(): number {
    return this.held;
  }

  async get(file: number, block: number, load: () => Promise<Uint8Array>): Promise<CachedBlock> {
    const key = `${file}:${block}`;
    const hit = this.entries.get(key);
    if (hit) {
      this.stats.hits++;
      this.entries.delete(key); // move to the most recently used end
      this.entries.set(key, hit);
      return hit;
    }
    const waiting = this.pending.get(key);
    if (waiting) {
      this.stats.hits++;
      return waiting;
    }
    const p = (async () => {
      this.stats.reads++;
      const data = await load();
      const entry: CachedBlock = { data, sum: await digest(data) };
      this.insert(key, entry);
      return entry;
    })();
    this.pending.set(key, p);
    try {
      return await p;
    } finally {
      this.pending.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.held = 0;
  }

  private insert(key: string, entry: CachedBlock): void {
    const size = entry.data.byteLength;
    if (size > this.maxBytes) return; // larger than the whole budget: serve it uncached
    this.entries.set(key, entry);
    this.held += size;
    for (const [k, e] of this.entries) {
      if (this.held <= this.maxBytes) break;
      this.entries.delete(k);
      this.held -= e.data.byteLength;
      this.stats.evictions++;
    }
  }
}

/** Default budget: 64 MiB (16 blocks of 4 MiB); `VITE_BLOCK_CACHE_MB` overrides it at build time. */
export function defaultBlockCacheBytes(env: string | undefined = import.meta.env.VITE_BLOCK_CACHE_MB): number {
  return blockCacheBytes(env);
}

/**
 * Cache budget from a megabyte setting: 64 MiB when unset or invalid, and never less than one block (4 MiB),
 * so a small value still caches the block receivers share instead of silently caching nothing.
 */
export function blockCacheBytes(mbSetting: string | undefined): number {
  const mb = Number(mbSetting);
  const bytes = (mbSetting && Number.isFinite(mb) && mb > 0 ? mb : 64) * 1024 * 1024;
  return Math.max(BLOCK_SIZE, Math.floor(bytes));
}
