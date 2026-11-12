// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify, nextStep, RouteMonitor, serverRoute, type PolicyStep, type StatsEntry } from './route';

const vectors = JSON.parse(
  readFileSync(new URL('../../../../../shared/protocol/schemas/route-vectors.json', import.meta.url), 'utf8'),
) as {
  monitor: import('./route').MonitorConfig;
  classify: { name: string; stats: unknown[]; kind: string | null; rttMs: number | null }[];
  policy: { from: string; next: string | null }[];
  sequences: { name: string; step?: string; steps: unknown[] }[];
};

type Step = {
  t: number;
  connected?: boolean;
  verified?: number;
  rttMs?: number;
  event?: string;
  rebase?: boolean;
  expect: string;
};

describe('route classifier (shared vectors)', () => {
  for (const v of vectors.classify) {
    it(v.name, () => {
      const c = classify(v.stats as StatsEntry[]);
      expect(c.kind).toBe(v.kind);
      expect(c.rttMs).toBe(v.rttMs);
    });
  }

  it('maps every relay kind to the server route relay', () => {
    expect(serverRoute('direct')).toBe('direct');
    for (const k of ['relay-udp', 'relay-tcp', 'relay-tls', 'relay'] as const) expect(serverRoute(k)).toBe('relay');
  });
});

describe('policy ladder (shared vectors)', () => {
  for (const p of vectors.policy) {
    it(`${p.from} → ${p.next ?? 'end'}`, () => expect(nextStep(p.from as PolicyStep)).toBe(p.next));
  }
});

describe('route monitor (shared vectors)', () => {
  for (const seq of vectors.sequences) {
    it(seq.name, () => {
      const m = new RouteMonitor((seq.step ?? 'all') as PolicyStep, vectors.monitor);
      for (const s of seq.steps as Step[]) {
        if (s.rebase) m.rebase(s.verified ?? 0, s.t);
        const got =
          s.event === 'lost'
            ? m.lost(s.t)
            : m.sample({ connected: !!s.connected, verified: s.verified ?? 0, rttMs: s.rttMs ?? null, now: s.t });
        expect(got, `t=${s.t}`).toBe(s.expect);
      }
    });
  }

  it('advances the step on each migration and smooths RTT and throughput', () => {
    const m = new RouteMonitor('all', vectors.monitor);
    m.sample({ connected: true, verified: 0, rttMs: 100, now: 0 });
    m.sample({ connected: true, verified: 2_000_000, rttMs: 0, now: 2000 });
    expect(m.rttMs).toBe(70);
    expect(m.bytesPerSecond).toBe(1_000_000);
    expect(m.sample({ connected: true, verified: 2_000_000, now: 14_000 })).toBe('migrate');
    expect(m.step).toBe('relay-udp');
  });
});
