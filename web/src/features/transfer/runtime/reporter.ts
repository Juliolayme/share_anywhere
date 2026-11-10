import type { Route, TransferStatus, TransfersApi } from './api';
import { pathTo, terminal } from './transitions';

/**
 * Reports one receiver's transfer states to the server (docs/TRANSFER_PROTOCOL.md §7): state changes at once,
 * walking through allowed intermediate states; progress at most every `intervalMs` while bytes flow. Calls
 * for one transfer are serialized so the server sees them in order.
 */
export class Reporter {
  private status = new Map<string, TransferStatus>();
  private verified = new Map<string, number>();
  private lastSent = new Map<string, number>();
  private chains = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  route: Route | undefined;

  constructor(
    private readonly api: TransfersApi,
    private readonly intervalMs = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seeds what the server already has (from the transfer list). */
  seed(transferId: string, status: TransferStatus, verified: number): void {
    this.status.set(transferId, status);
    this.verified.set(transferId, verified);
  }

  current(transferId: string): TransferStatus | undefined {
    return this.status.get(transferId);
  }

  /** Moves a transfer to `target` (no-op once terminal). */
  state(transferId: string, target: TransferStatus, verified?: number): Promise<void> {
    if (verified !== undefined) this.verified.set(transferId, Math.max(verified, this.verified.get(transferId) ?? 0));
    return this.enqueue(transferId, async () => {
      const from = this.status.get(transferId) ?? 'PENDING';
      if (terminal(from)) return;
      for (const s of pathTo(from, target)) await this.send(transferId, s);
    });
  }

  /** Progress while the state stays the same; throttled. */
  progress(transferId: string, verified: number): void {
    this.verified.set(transferId, Math.max(verified, this.verified.get(transferId) ?? 0));
    if (this.timers.has(transferId)) return;
    const wait = Math.max(0, (this.lastSent.get(transferId) ?? -Infinity) + this.intervalMs - this.now());
    this.timers.set(
      transferId,
      setTimeout(() => {
        this.timers.delete(transferId);
        void this.enqueue(transferId, async () => {
          const s = this.status.get(transferId);
          if (s && !terminal(s)) await this.send(transferId, s);
        });
      }, wait),
    );
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private enqueue(transferId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(transferId) ?? Promise.resolve()).then(fn).catch(() => undefined);
    this.chains.set(transferId, next);
    return next;
  }

  private async send(transferId: string, status: TransferStatus): Promise<void> {
    const t = await this.api.report(transferId, status, this.verified.get(transferId) ?? 0, this.route);
    this.status.set(transferId, t.status);
    this.lastSent.set(transferId, this.now());
  }
}
