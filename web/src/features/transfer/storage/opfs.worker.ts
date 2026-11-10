/// <reference lib="webworker" />
// Receiver storage in the Origin Private File System through synchronous access handles, which every
// engine supports in dedicated workers (Chromium, Firefox, Safari 17+). Writes are positional, so blocks may
// arrive in any order and a reload resumes into the same file (docs/TRANSFER_PROTOCOL.md §4).

const DIR = 'sa-incoming';
const open = new Map<string, FileSystemSyncAccessHandle>();

interface Req {
  id: number;
  op: 'probe' | 'open' | 'write' | 'read' | 'flush' | 'close' | 'remove';
  name?: string;
  size?: number;
  offset?: number;
  length?: number;
  data?: ArrayBuffer;
}

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

function handle(name: string | undefined): FileSystemSyncAccessHandle {
  const h = name ? open.get(name) : undefined;
  if (!h) throw new DOMException(`${name ?? ''} is not open`, 'InvalidStateError');
  return h;
}

async function run(r: Req): Promise<{ result?: unknown; transfer?: Transferable[] }> {
  switch (r.op) {
    case 'probe': {
      const d = await dir();
      const fh = await d.getFileHandle('.probe', { create: true });
      const h = await fh.createSyncAccessHandle();
      h.write(new Uint8Array([1]), { at: 0 });
      h.close();
      await d.removeEntry('.probe');
      return { result: true };
    }
    case 'open': {
      const name = r.name ?? '';
      if (open.has(name)) return { result: open.get(name)?.getSize() };
      const fh = await (await dir()).getFileHandle(name, { create: true });
      const h = await fh.createSyncAccessHandle();
      // Reserve the full size up front so a storage shortage shows before any block is sent.
      if (r.size !== undefined && h.getSize() < r.size) h.truncate(r.size);
      open.set(name, h);
      return { result: h.getSize() };
    }
    case 'write': {
      const h = handle(r.name);
      const data = new Uint8Array(r.data ?? new ArrayBuffer(0));
      const n = h.write(data, { at: r.offset ?? 0 });
      if (n !== data.byteLength) throw new DOMException('Short write', 'QuotaExceededError');
      return { result: n };
    }
    case 'read': {
      const h = handle(r.name);
      const buf = new Uint8Array(r.length ?? 0);
      const n = h.read(buf, { at: r.offset ?? 0 });
      return { result: buf.buffer.slice(0, n), transfer: [] };
    }
    case 'flush':
      handle(r.name).flush();
      return {};
    case 'close': {
      const h = r.name ? open.get(r.name) : undefined;
      if (h) {
        h.flush();
        h.close();
        open.delete(r.name ?? '');
      }
      return {};
    }
    case 'remove': {
      const h = r.name ? open.get(r.name) : undefined;
      if (h) {
        h.close();
        open.delete(r.name ?? '');
      }
      await (await dir()).removeEntry(r.name ?? '').catch(() => undefined);
      return {};
    }
  }
}

self.onmessage = (e: MessageEvent<Req>) => {
  const r = e.data;
  run(r).then(
    ({ result }) => {
      const transfer = result instanceof ArrayBuffer ? [result] : [];
      (self as unknown as Worker).postMessage({ id: r.id, ok: true, result }, transfer);
    },
    (err: unknown) => {
      const ex = err instanceof Error ? err : new Error(String(err));
      (self as unknown as Worker).postMessage({ id: r.id, ok: false, name: ex.name, message: ex.message });
    },
  );
};
