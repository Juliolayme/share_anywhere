import type { Route, TransfersApi } from './api';

/** Test builds only (VITE_TEST_HOOKS): lets a spec force relay-only ICE (docs/TESTING_AND_CI.md §3). */
function testPolicy(): RTCIceTransportPolicy | undefined {
  if (import.meta.env.VITE_TEST_HOOKS !== 'true') return undefined;
  return (window as unknown as { __SA_TEST_ICE_POLICY?: RTCIceTransportPolicy }).__SA_TEST_ICE_POLICY;
}

/**
 * ICE configuration for a session: the TURN credentials from the server plus a STUN URI on the same host
 * and port (coturn answers binding requests there), so server-reflexive candidates exist even where host
 * candidates are hidden behind mDNS names.
 */
export async function rtcConfig(api: TransfersApi, sessionId: string): Promise<RTCConfiguration> {
  const servers: RTCIceServer[] = [];
  try {
    const c = await api.turn(sessionId);
    if (c.uris.length) {
      const stun = [
        ...new Set(
          c.uris.filter((u) => u.startsWith('turn:')).map((u) => u.replace(/^turn:/, 'stun:').replace(/\?.*$/, '')),
        ),
      ];
      if (stun.length) servers.push({ urls: stun });
      servers.push({ urls: c.uris, username: c.username, credential: c.credential });
    }
  } catch {
    // Without TURN credentials, direct (host or LAN) candidates may still connect.
  }
  const policy = testPolicy();
  return { iceServers: servers, ...(policy ? { iceTransportPolicy: policy } : {}) };
}

/** The route of the selected candidate pair: relay when either end is a TURN relay candidate. */
export async function selectedRoute(pc: RTCPeerConnection): Promise<Route | null> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((s: { type: string; selectedCandidatePairId?: string }) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
    stats.forEach(
      (s: {
        type: string;
        id: string;
        nominated?: boolean;
        state?: string;
        selected?: boolean;
        localCandidateId?: string;
        remoteCandidateId?: string;
      }) => {
        if (s.type !== 'candidate-pair') return;
        if ((pairId && s.id === pairId) || (!pairId && (s.selected || (s.nominated && s.state === 'succeeded'))))
          pair = s;
      },
    );
    if (!pair) return null;
    const type = (id?: string) =>
      id ? (stats.get(id) as { candidateType?: string } | undefined)?.candidateType : undefined;
    return type(pair.localCandidateId) === 'relay' || type(pair.remoteCandidateId) === 'relay' ? 'relay' : 'direct';
  } catch {
    return null;
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
