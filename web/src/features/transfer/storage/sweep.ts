import { listOpfs, removeOpfs } from './opfs';
import type { ProgressStore } from './progress-store';

/** Finished and abandoned receives are kept this long, so a finished file can be downloaded again. */
export const KEEP_MS = 24 * 60 * 60 * 1000;
/** A staging file with no progress record is left alone this long (another tab may be starting it). */
const ORPHAN_MS = 60 * 60 * 1000;

/**
 * Frees browser storage (docs/TRANSFER_PROTOCOL.md §4): progress records untouched for 24 hours go with their
 * staging files, and staging files no record refers to are removed after an hour. Runs once per tab.
 */
export async function sweepStorage(store: ProgressStore, now = Date.now()): Promise<number> {
  let removed = 0;
  const rows = await store.all().catch(() => []);
  const keep = new Set<string>();
  for (const p of rows) {
    if (now - p.updatedAt > KEEP_MS) {
      await removeOpfs(p.staging);
      await store.remove(p.key).catch(() => undefined);
      removed++;
    } else keep.add(p.staging);
  }
  for (const f of await listOpfs()) {
    if (!keep.has(f.name) && f.name !== '.probe' && now - f.modified > ORPHAN_MS) {
      await removeOpfs(f.name);
      removed++;
    }
  }
  return removed;
}
