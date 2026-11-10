import type { components } from '../../lib/api/schema.gen';
import type { DeviceClient } from '../../lib/api/device-client';

type S = components['schemas'];
export type SessionView = S['SessionView'];
export type JoinPreview = S['JoinPreview'];
export type JoinResult = S['JoinResult'];
export type Participant = S['Participant'];
export type FileInput = S['FileInput'];

/** Typed calls for docs/API.md §2.2, all authenticated with the device token. */
export function sessionsApi(client: DeviceClient) {
  return {
    create: (files: FileInput[], requireApproval: boolean) =>
      client.request<SessionView>('POST', '/v1/sessions', { files, require_approval: requireApproval }),
    get: (id: string) => client.request<SessionView>('GET', `/v1/sessions/${encodeURIComponent(id)}`),
    update: (id: string, body: S['UpdateSessionRequest']) =>
      client.request<SessionView>('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, body),
    renew: (id: string) => client.request<SessionView>('POST', `/v1/sessions/${encodeURIComponent(id)}/renew`),
    close: (id: string) => client.request<{ status: string }>('POST', `/v1/sessions/${encodeURIComponent(id)}/close`),
    resolveCode: (code: string) => client.request<JoinPreview>('POST', '/v1/sessions/resolve-code', { code }),
    resolveLink: (token: string) => client.request<JoinPreview>('POST', '/v1/sessions/resolve-link', { token }),
    join: (id: string, ticket: string) =>
      client.request<JoinResult>('POST', `/v1/sessions/${encodeURIComponent(id)}/join`, { ticket }),
    decide: (participantId: string, action: 'approve' | 'reject' | 'block' | 'leave') =>
      client.request<Participant>('POST', `/v1/participants/${encodeURIComponent(participantId)}/${action}`),
    remove: (participantId: string) =>
      client.request<Participant>('DELETE', `/v1/participants/${encodeURIComponent(participantId)}`),
  };
}

/** Milliseconds to add to Date.now() to follow the server clock, from a response's server_time. */
export function serverOffset(serverTime: string, now = Date.now()): number {
  const t = Date.parse(serverTime);
  return Number.isFinite(t) ? t - now : 0;
}

/** Seconds left until an ISO timestamp on the server clock (never negative). */
export function secondsUntil(iso: string, offsetMs: number, now = Date.now()): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - (now + offsetMs)) / 1000));
}

/** "m:ss" for countdowns (10:00, 0:59). */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
