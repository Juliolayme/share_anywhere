/**
 * Throughput and ETA (docs/PRODUCT_REQUIREMENTS.md §6.5): EWMA of verified bytes per second; the ETA is
 * provisional ("Estimating time…") until progress passes 3 % and while reconnecting.
 */
export interface Estimate {
  bytesPerSecond: number;
  /** Seconds remaining, or null while the estimate is provisional. */
  seconds: number | null;
}

export class Throughput {
  private rate = 0;
  private lastBytes = 0;
  private lastAt = 0;
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
      return;
    }
    const dt = now - this.lastAt;
    if (dt < this.minIntervalMs) return;
    const r = (Math.max(0, verifiedBytes - this.lastBytes) * 1000) / dt;
    this.rate = this.rate === 0 ? r : this.alpha * r + (1 - this.alpha) * this.rate;
    this.lastBytes = verifiedBytes;
    this.lastAt = now;
  }

  /** Restarts the baseline (after a pause or reconnect) without forgetting the smoothed rate. */
  rebase(verifiedBytes: number, now: number): void {
    this.lastBytes = verifiedBytes;
    this.lastAt = now;
    this.started = true;
  }

  estimate(verifiedBytes: number, totalBytes: number, reconnecting = false): Estimate {
    const progress = totalBytes > 0 ? verifiedBytes / totalBytes : 1;
    const provisional = reconnecting || progress <= 0.03 || this.rate <= 0;
    return {
      bytesPerSecond: this.rate,
      seconds: provisional ? null : Math.max(0, Math.ceil((totalBytes - verifiedBytes) / this.rate)),
    };
  }
}
