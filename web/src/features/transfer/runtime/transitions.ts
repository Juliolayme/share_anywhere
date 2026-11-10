import type { TransferStatus } from './api';

/**
 * Client mirror of the server's transfer state machine (backend/internal/transfers/model.go,
 * docs/ARCHITECTURE.md §4.5). The server validates every report; the client uses this to walk to a target
 * state through allowed steps (for example DISCONNECTED → RECONNECTING → RESUMING → TRANSFERRING).
 */
export const NEXT: Record<TransferStatus, TransferStatus[]> = {
  PENDING: ['CONNECTING', 'PAUSED', 'FAILED', 'CANCELLED'],
  CONNECTING: ['TRANSFERRING', 'RESUMING', 'DISCONNECTED', 'PAUSED', 'FAILED', 'CANCELLED'],
  TRANSFERRING: ['PAUSED', 'DISCONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  PAUSED: ['CONNECTING', 'RESUMING', 'TRANSFERRING', 'FAILED', 'CANCELLED'],
  DISCONNECTED: ['RECONNECTING', 'CONNECTING', 'PAUSED', 'FAILED', 'CANCELLED'],
  RECONNECTING: ['RESUMING', 'CONNECTING', 'DISCONNECTED', 'PAUSED', 'FAILED', 'CANCELLED'],
  RESUMING: ['TRANSFERRING', 'DISCONNECTED', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const terminal = (s: TransferStatus) => s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELLED';

/** Shortest list of states to report to get from `from` to `to` (empty when already there or unreachable). */
export function pathTo(from: TransferStatus, to: TransferStatus): TransferStatus[] {
  if (from === to) return [];
  const prev = new Map<TransferStatus, TransferStatus>();
  const queue: TransferStatus[] = [from];
  while (queue.length) {
    const cur = queue.shift() as TransferStatus;
    for (const n of NEXT[cur]) {
      if (n === from || prev.has(n)) continue;
      prev.set(n, cur);
      if (n === to) {
        const path: TransferStatus[] = [to];
        let p = cur;
        while (p !== from) {
          path.unshift(p);
          p = prev.get(p) as TransferStatus;
        }
        return path;
      }
      queue.push(n);
    }
  }
  return [];
}
