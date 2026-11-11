import type { components } from '../../lib/api/schema.gen';
import type { DeviceClient } from '../../lib/api/device-client';

// Clipboard Sync endpoints (docs/API.md §2.5, docs/CLIPBOARD_PROTOCOL.md §2). Every route is `account+device`.
// Binary fields are base64url without padding. Loaded on demand with the clipboard runtime.

type S = components['schemas'];

/** One event as `GET /v1/clipboard/events` and `GET /v1/clipboard/history` return it. Tombstones have no payload. */
export type RemoteClipboardEvent = S['ClipboardEvent'];
export type ClipboardEventsPage = S['ClipboardEventPage'];
/** Live events newest first, and the account's highest `seq` (0 when there is none) to follow with `events?cursor=`. */
export type ClipboardHistory = S['ClipboardHistory'];
export type ClipboardEventRequest = S['ClipboardEventRequest'];
export type ClipboardEventCreated = S['ClipboardEventCreated'];
export type ClipboardSettings = S['ClipboardSettings'];

export function clipboardApi(client: DeviceClient) {
  const r = <T>(method: string, path: string, body?: unknown) => client.request<T>(method, path, body);
  return {
    history: (limit = 100) => r<ClipboardHistory>('GET', `/v1/clipboard/history?limit=${limit}`),
    events: (cursor: number, limit = 100) =>
      r<ClipboardEventsPage>('GET', `/v1/clipboard/events?cursor=${cursor}&limit=${limit}`),
    create: (req: ClipboardEventRequest) => r<ClipboardEventCreated>('POST', '/v1/clipboard/events', req),
    remove: (eventId: string) => r<undefined>('DELETE', `/v1/clipboard/events/${encodeURIComponent(eventId)}`),
    clear: () => r<undefined>('DELETE', '/v1/clipboard/history'),
    settings: () => r<ClipboardSettings>('GET', '/v1/clipboard/settings'),
    saveSettings: (s: ClipboardSettings) => r<ClipboardSettings>('PUT', '/v1/clipboard/settings', s),
  };
}

export type ClipboardApi = ReturnType<typeof clipboardApi>;

/** Payload limit (PRD §7.6): UTF-8 bytes of the plaintext. */
export const MAX_PAYLOAD_BYTES = 262_144;
/** Live events the server keeps per account; the oldest is tombstoned when a 101st arrives. */
export const MAX_EVENTS = 100;
