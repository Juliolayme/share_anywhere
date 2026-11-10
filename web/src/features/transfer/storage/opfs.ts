import type { Sink } from '../engine/receiver';

const DIR = 'sa-incoming';

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (
      e: MessageEvent<{ id: number; ok: boolean; result?: unknown; name?: string; message?: string }>,
    ) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new DOMException(e.data.message ?? 'Storage error', e.data.name ?? 'UnknownError'));
    };
    worker.onerror = (e) => {
      for (const p of pending.values())
        p.reject(new DOMException(e.message || 'Storage worker failed', 'UnknownError'));
      pending.clear();
    };
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker?.postMessage({ id, ...msg }, transfer);
  });
}

/** True when OPFS with synchronous access handles works here (false in Firefox private windows, for instance). */
export async function probeOpfs(): Promise<boolean> {
  if (typeof Worker === 'undefined' || !navigator.storage?.getDirectory) return false;
  try {
    return await Promise.race([
      call<boolean>({ op: 'probe' }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
  } catch {
    return false;
  }
}

export interface OpfsSink extends Sink {
  readonly name: string;
  close(): Promise<void>;
  remove(): Promise<void>;
}

/** Opens (or reopens after a reload) the staging file for one transfer, reserving `size` bytes. */
export async function openOpfsSink(name: string, size: number): Promise<OpfsSink> {
  await call({ op: 'open', name, size });
  return {
    name,
    write: async (offset, data) => {
      const copy = data.slice().buffer; // transferred to the worker
      await call({ op: 'write', name, offset, data: copy }, [copy]);
    },
    read: async (offset, length) => new Uint8Array(await call<ArrayBuffer>({ op: 'read', name, offset, length })),
    flush: () => call({ op: 'flush', name }),
    close: () => call({ op: 'close', name }),
    remove: () => call({ op: 'remove', name }),
  };
}

/** The finished file as a disk-backed File (for download or copying into a chosen folder). */
export async function opfsFile(name: string, downloadName: string, type: string): Promise<File> {
  await call({ op: 'close', name });
  const root = await navigator.storage.getDirectory();
  const fh = await (await root.getDirectoryHandle(DIR, { create: true })).getFileHandle(name);
  const f = await fh.getFile();
  return new File([f], downloadName, { type: type || f.type });
}

export async function removeOpfs(name: string): Promise<void> {
  try {
    await call({ op: 'remove', name });
  } catch {
    /* already gone */
  }
}
