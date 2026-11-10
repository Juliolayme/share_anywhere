/**
 * Throughput and ETA (docs/PRODUCT_REQUIREMENTS.md §6.5): EWMA of verified bytes per second; the ETA is
 * provisional ("Estimating time…") until progress passes 3 %, while reconnecting, when no bytes have arrived for
 * 10 seconds (the smoothed rate only decays toward zero), and when it would exceed a week.
 */
const STALL_MS = 10_000;
const MAX_SECONDS = 7 * 24 * 3600;

export interface Estimate {
  bytesPerSecond: number;
  /** Seconds remaining, or null while the estimate is provisional. */
  seconds: number | null;
}

export class Throughput {
  private rate = 0;
  private lastBytes = 0;
  private lastAt = 0;
  private lastProgressAt = 0;
  private started = false;

  constructor(
    private readonly alpha = 0.3,
    private readonly minIntervalMs = 400,
  ) {}

  /** Feeds the current verified byte count at time `now` (ms). */
  sample(verifiedBytes: number, now: number): void {
    if (!this.started) {
      this.started = true;
      this.lastBytes = verifiedBytes;
      this.lastAt = now;
      this.lastProgressAt = now;
      return;
    }
    const dt = now - this.lastAt;
    if (dt < this.minIntervalMs) return;
    if (verifiedBytes > this.lastBytes) this.lastProgressAt = now;
    const r = (Math.max(0, verifiedBytes - this.lastBytes) * 1000) / dt;
    this.rate = this.rate === 0 ? r : this.alpha * r + (1 - this.alpha) * this.rate;
    this.lastBytes = verifiedBytes;
    this.lastAt = now;
  }

  /** Restarts the baseline (after a pause or reconnect) without forgetting the smoothed rate. */
  rebase(verifiedBytes: number, now: number): void {
    this.lastBytes = verifiedBytes;
    this.lastAt = now;
    this.lastProgressAt = now;
    this.started = true;
  }

  estimate(verifiedBytes: number, totalBytes: number, reconnecting = false): Estimate {
    const progress = totalBytes > 0 ? verifiedBytes / totalBytes : 1;
    const stalled = this.lastAt - this.lastProgressAt >= STALL_MS;
    const provisional = reconnecting || progress <= 0.03 || this.rate <= 0 || stalled;
    const seconds = provisional ? null : Math.max(0, Math.ceil((totalBytes - verifiedBytes) / this.rate));
    return {
      bytesPerSecond: stalled ? 0 : this.rate,
      seconds: seconds !== null && seconds > MAX_SECONDS ? null : seconds,
    };
  }
}
