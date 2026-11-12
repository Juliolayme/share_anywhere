/**
 * Route strategy (docs/ARCHITECTURE.md §6, docs/PRODUCT_REQUIREMENTS.md §6.3): classify the selected ICE candidate
 * pair, and decide when a receiver should move its connection one step stricter (all routes → TURN over UDP →
 * TURN over TLS). Pure logic shared byte for byte with Android and iOS through
 * `shared/protocol/schemas/route-vectors.json`.
 */

/** What the selected candidate pair runs over. `relay` alone: only the remote end relays (transport unknown). */
export type RouteKind = 'direct' | 'relay-udp' | 'relay-tcp' | 'relay-tls' | 'relay';

/** ICE policy steps, from the most permissive. */
export type PolicyStep = 'all' | 'relay-udp' | 'relay-tls';

export const POLICY_LADDER: PolicyStep[] = ['all', 'relay-udp', 'relay-tls'];

export function nextStep(step: PolicyStep): PolicyStep | null {
  const i = POLICY_LADDER.indexOf(step);
  return POLICY_LADDER[i + 1] ?? null;
}

/** The server's route value (`direct`, `relay`; `cloud` is reported by the cloud path). */
export function serverRoute(kind: RouteKind): 'direct' | 'relay' {
  return kind === 'direct' ? 'direct' : 'relay';
}

/** A stats entry with the fields the classifier reads (an RTCStats subset). */
export interface StatsEntry {
  type: string;
  id: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  selected?: boolean;
  nominated?: boolean;
  state?: string;
  candidateType?: string;
  relayProtocol?: string;
}

export interface Classified {
  kind: RouteKind | null;
  rttMs: number | null;
}

/** Classifies the selected candidate pair: from the transport's selected pair, else the `selected` pair (Firefox). */
export function classify(stats: Iterable<StatsEntry>): Classified {
  const byId = new Map<string, StatsEntry>();
  let pairId: string | undefined;
  for (const s of stats) {
    byId.set(s.id, s);
    if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
  }
  let pair: StatsEntry | undefined = pairId ? byId.get(pairId) : undefined;
  if (!pair) {
    for (const s of byId.values()) {
      if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
    }
  }
  if (!pair) return { kind: null, rttMs: null };
  const local = pair.localCandidateId ? byId.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId ? byId.get(pair.remoteCandidateId) : undefined;
  const rttMs = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
  let kind: RouteKind;
  if (local?.candidateType === 'relay') {
    const p = local.relayProtocol;
    kind = p === 'tls' ? 'relay-tls' : p === 'tcp' ? 'relay-tcp' : p === 'udp' ? 'relay-udp' : 'relay';
  } else if (remote?.candidateType === 'relay') {
    kind = 'relay';
  } else {
    kind = 'direct';
  }
  return { kind, rttMs };
}

export interface MonitorConfig {
  sampleMs: number;
  stallMs: number;
  cooldownMs: number;
  lossWindowMs: number;
  lossesToEscalate: number;
  alpha: number;
}

export const MONITOR_DEFAULTS: MonitorConfig = {
  sampleMs: 2000,
  stallMs: 12_000,
  cooldownMs: 30_000,
  lossWindowMs: 120_000,
  lossesToEscalate: 2,
  alpha: 0.3,
};

export type Decision = 'stay' | 'migrate';

/**
 * Watches one receiver connection. Hysteresis: a short pause or an RTT spike never migrates; only a stall of
 * `stallMs` without verified progress while connected, or `lossesToEscalate` channel losses on the same step within
 * `lossWindowMs`. A migration advances the step, clears the losses and starts a cooldown; the last step never
 * migrates (the reconnect window then decides, docs/TRANSFER_PROTOCOL.md §6).
 */
export class RouteMonitor {
  private lastVerified = -1;
  private lastProgressAt = 0;
  private started = false;
  private lastMigrationAt = Number.NEGATIVE_INFINITY;
  private losses: number[] = [];
  private rtt: number | null = null;
  private rate = 0;
  private lastSampleAt = 0;

  constructor(
    public step: PolicyStep = 'all',
    private readonly config: MonitorConfig = MONITOR_DEFAULTS,
  ) {}

  /** Smoothed round-trip time in ms (null before the first measurement). */
  get rttMs(): number | null {
    return this.rtt === null ? null : Math.round(this.rtt);
  }

  /** Smoothed verified bytes per second. */
  get bytesPerSecond(): number {
    return this.rate;
  }

  /** Restarts the progress baseline on a new channel. */
  rebase(verified: number, now: number): void {
    this.lastVerified = verified;
    this.lastProgressAt = now;
    this.lastSampleAt = now;
    this.started = true;
  }

  /** One periodic sample of the current connection. */
  sample(s: { connected: boolean; verified: number; rttMs?: number | null; now: number }): Decision {
    const a = this.config.alpha;
    if (typeof s.rttMs === 'number') this.rtt = this.rtt === null ? s.rttMs : a * s.rttMs + (1 - a) * this.rtt;
    if (!this.started) {
      this.rebase(s.verified, s.now);
      return 'stay';
    }
    const dt = s.now - this.lastSampleAt;
    if (dt > 0) {
      const r = (Math.max(0, s.verified - this.lastVerified) * 1000) / dt;
      this.rate = this.rate === 0 ? r : a * r + (1 - a) * this.rate;
    }
    this.lastSampleAt = s.now;
    if (!s.connected || s.verified > this.lastVerified) {
      this.lastVerified = Math.max(this.lastVerified, s.verified);
      this.lastProgressAt = s.now;
      return 'stay';
    }
    return s.now - this.lastProgressAt >= this.config.stallMs ? this.migrate(s.now) : 'stay';
  }

  /**
   * Back to `step` (the receiver's starting step) after dials on a stricter step never opened: the relay is not
   * usable from here (unreachable, or refused like loopback TURN in Firefox). Clears the losses and starts the
   * cooldown, so a later stall or loss pair can migrate again.
   */
  reset(step: PolicyStep, now: number): void {
    this.step = step;
    this.losses = [];
    this.lastMigrationAt = now;
    this.lastProgressAt = now;
  }

  /** A channel that had opened was lost (ICE failed, channel closed). */
  lost(now: number): Decision {
    this.losses = [...this.losses.filter((t) => now - t < this.config.lossWindowMs), now];
    return this.losses.length >= this.config.lossesToEscalate ? this.migrate(now) : 'stay';
  }

  private migrate(now: number): Decision {
    const next = nextStep(this.step);
    if (!next || now - this.lastMigrationAt < this.config.cooldownMs) return 'stay';
    this.step = next;
    this.lastMigrationAt = now;
    this.losses = [];
    this.lastProgressAt = now;
    return 'migrate';
  }
}
