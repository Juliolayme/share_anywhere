import type { components } from '../../../lib/api/schema.gen';
import type { DeviceClient } from '../../../lib/api/device-client';

type S = components['schemas'];
export type CloudSettings = S['CloudSettings'];
export type CloudEstimate = S['CloudEstimate'];
export type CloudObject = S['CloudObject'];

/** Typed calls for Cloud Distribution (docs/API.md §2.6). Parts travel as raw bytes. */
export function cloudApi(client: DeviceClient) {
  const id = encodeURIComponent;
  return {
    settings: () => client.request<CloudSettings>('GET', '/v1/cloud/settings'),
    putSettings: (enabled: boolean, consent: boolean, budgetBytes?: number) =>
      client.request<CloudSettings>('PUT', '/v1/cloud/settings', {
        enabled,
        consent,
        ...(budgetBytes !== undefined ? { budget_bytes: budgetBytes } : {}),
      }),
    estimate: (bytes: number, receivers: number) =>
      client.request<CloudEstimate>('POST', '/v1/cloud/estimate', { bytes, receivers }),
    distribute: (fileId: string) => client.request<CloudObject>('POST', `/v1/files/${id(fileId)}/distribute`),
    putPart: async (objectId: string, n: number, bytes: Uint8Array) => {
      const raw = await client.requestBytes('PUT', `/v1/cloud/objects/${id(objectId)}/parts/${n}`, bytes);
      return JSON.parse(new TextDecoder().decode(raw)) as CloudObject;
    },
    seal: (objectId: string) => client.request<CloudObject>('POST', `/v1/cloud/objects/${id(objectId)}/seal`),
    list: (sessionId: string) =>
      client.request<{ objects: CloudObject[] }>('GET', `/v1/sessions/${id(sessionId)}/cloud`).then((r) => r.objects),
    getPart: (objectId: string, n: number) =>
      client.requestBytes('GET', `/v1/cloud/objects/${id(objectId)}/parts/${n}`),
    received: (objectId: string) => client.request<CloudObject>('POST', `/v1/cloud/objects/${id(objectId)}/received`),
  };
}

export type CloudApi = ReturnType<typeof cloudApi>;
