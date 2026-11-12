import type { components } from '../../../lib/api/schema.gen';
import type { DeviceClient } from '../../../lib/api/device-client';

type S = components['schemas'];
export type Transfer = S['Transfer'];
export type TransferList = S['TransferList'];
export type TransferStatus = S['TransferStatus'];
export type TurnCredentials = S['TurnCredentials'];
export type Route = 'direct' | 'relay' | 'cloud';

/** Typed calls for docs/API.md §2.3 and TURN credentials. */
export function transfersApi(client: DeviceClient) {
  const id = encodeURIComponent;
  return {
    list: (sessionId: string) => client.request<TransferList>('GET', `/v1/sessions/${id(sessionId)}/transfers`),
    report: (transferId: string, status: TransferStatus, verified: number, route?: Route) =>
      client.request<Transfer>('POST', `/v1/transfers/${id(transferId)}/report`, {
        status,
        verified_bytes: verified,
        ...(route ? { route } : {}),
      }),
    action: (transferId: string, action: 'pause' | 'resume' | 'cancel', capability?: string) =>
      client.request<Transfer>(
        'POST',
        `/v1/transfers/${id(transferId)}/${action}`,
        capability ? { capability } : undefined,
      ),
    turn: (sessionId: string) =>
      client.request<TurnCredentials>('POST', '/v1/turn/credentials', { session_id: sessionId }),
  };
}

export type TransfersApi = ReturnType<typeof transfersApi>;
