import { ApiError } from '../../../lib/api/errors';
import { classify, type Classified, type PolicyStep, type StatsEntry } from '../engine/route';
import type { TransfersApi } from './api';

type TestWindow = { __SA_TEST_ICE_POLICY?: RTCIceTransportPolicy; __SA_TEST_ROUTE_STEP?: PolicyStep };

/** Test builds only (VITE_TEST_HOOKS): lets a spec force relay-only ICE (docs/TESTING_AND_CI.md §3). */
function testPolicy(): RTCIceTransportPolicy | undefined {
  if (import.meta.env.VITE_TEST_HOOKS !== 'true') return undefined;
  return (window as unknown as TestWindow).__SA_TEST_ICE_POLICY;
}

/** Test builds only: the policy step a receiver starts on (`relay-udp`, `relay-tls`) instead of `all`. */
export function testRouteStep(): PolicyStep | undefined {
  if (import.meta.env.VITE_TEST_HOOKS !== 'true') return undefined;
  return (window as unknown as TestWindow).__SA_TEST_ROUTE_STEP;
}

/**
 * TURN URIs a policy step may use: UDP for `relay-udp`; TLS for `relay-tls` (TCP when no TLS URI is configured); all
 * for `all`. A step with nothing to use keeps every URI rather than none.
 */
export function urisForStep(uris: string[], step: PolicyStep): string[] {
  const udp = (u: string) => u.startsWith('turn:') && !/transport=tcp/i.test(u);
  const tls = (u: string) => u.startsWith('turns:');
  const tcp = (u: string) => u.startsWith('turn:') && /transport=tcp/i.test(u);
  let pick = uris;
  if (step === 'relay-udp') pick = uris.filter(udp);
  if (step === 'relay-tls') pick = uris.some(tls) ? uris.filter(tls) : uris.filter(tcp);
  return pick.length ? pick : uris;
}

export interface RtcSetup {
  config: RTCConfiguration;
  /** The server refused TURN credentials (`relay_cap_reached`, `rate_limited`, …); null when issued. */
  turnRefused: string | null;
  /** When the TURN credential expires (ms since epoch), for renewal before a relayed connection loses it. */
  expiresAt: number | null;
}

/**
 * ICE configuration for a session on a policy step (docs/ARCHITECTURE.md §6): the TURN credentials from the server
 * plus a STUN URI on the same host and port (coturn answers binding requests there), so server-reflexive candidates
 * exist even where host candidates are hidden behind mDNS names. Any step but `all` is relay-only.
 */
export async function rtcSetup(api: TransfersApi, sessionId: string, step: PolicyStep = 'all'): Promise<RtcSetup> {
  const servers: RTCIceServer[] = [];
  let turnRefused: string | null = null;
  let expiresAt: number | null = null;
  try {
    const c = await api.turn(sessionId);
    const uris = urisForStep(c.uris, step);
    if (uris.length) {
      const stun = [
        ...new Set(
          c.uris.filter((u) => u.startsWith('turn:')).map((u) => u.replace(/^turn:/, 'stun:').replace(/\?.*$/, '')),
        ),
      ];
      if (stun.length && step === 'all') servers.push({ urls: stun });
      servers.push({ urls: uris, username: c.username, credential: c.credential });
    }
    expiresAt = Date.parse(c.expires_at) || null;
  } catch (e) {
    // Without TURN credentials, direct (host or LAN) candidates may still connect.
    turnRefused = e instanceof ApiError ? e.code : 'network';
  }
  const policy = testPolicy() ?? (step === 'all' ? undefined : 'relay');
  return { config: { iceServers: servers, ...(policy ? { iceTransportPolicy: policy } : {}) }, turnRefused, expiresAt };
}

/** The ICE configuration alone (the sender answers on whatever route the receiver offers). */
export async function rtcConfig(api: TransfersApi, sessionId: string): Promise<RTCConfiguration> {
  return (await rtcSetup(api, sessionId)).config;
}

/** Classifies the selected candidate pair of a live connection (null fields until one is selected). */
export async function classifyPeer(pc: RTCPeerConnection): Promise<Classified> {
  try {
    const stats = await pc.getStats();
    const entries: StatsEntry[] = [];
    stats.forEach((s: StatsEntry) => entries.push(s));
    return classify(entries);
  } catch {
    return { kind: null, rttMs: null };
  }
}

/** Signaling payloads relayed by the server (opaque to it). `conn` ties answers and candidates to one attempt. */
export interface SdpPayload {
  conn: string;
  sdp: RTCSessionDescriptionInit;
}
export interface CandidatePayload {
  conn: string;
  candidate: RTCIceCandidateInit | null;
}

export const CHANNEL_LABEL = 'sa-transfer/1';

/** Appends one diagnostics line: truncated, and the list keeps only the latest 200 (memory only). */
export function pushDiag(out: string[], line: string): void {
  out.push(line.length > 300 ? `${line.slice(0, 300)}…` : line);
  if (out.length > 200) out.splice(0, out.length - 200);
}

/**
 * Records ICE and connection progress for diagnostics (kept in memory, shown nowhere, read by test builds and
 * useful in a debugger): gathering and connection states, local candidate types, and ICE errors.
 */
export function watchPeer(pc: RTCPeerConnection, out: string[]): void {
  const push = (s: string) => pushDiag(out, `${Math.round(performance.now())} ${s}`);
  pc.addEventListener('icegatheringstatechange', () => push(`gather ${pc.iceGatheringState}`));
  pc.addEventListener('iceconnectionstatechange', () => push(`ice ${pc.iceConnectionState}`));
  pc.addEventListener('connectionstatechange', () => push(`conn ${pc.connectionState}`));
  pc.addEventListener('icecandidate', (e) => {
    const c = (e as RTCPeerConnectionIceEvent).candidate;
    push(c ? `local ${c.type ?? '?'} ${c.protocol ?? ''} ${c.address ?? ''}` : 'local end');
  });
  pc.addEventListener('icecandidateerror', (e) => {
    const x = e as RTCPeerConnectionIceErrorEvent;
    push(`ice-error ${x.errorCode} ${x.url ?? ''} ${x.errorText ?? ''}`);
  });
}
