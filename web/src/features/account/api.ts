import type { components } from '../../lib/api/schema.gen';
import type { DeviceClient } from '../../lib/api/device-client';

type S = components['schemas'];
export type AuthResult = S['AuthResult'];
export type AccountToken = S['AccountToken'];
export type Me = S['Me'];
export type AccountDevice = S['AccountDevice'];
export type KeysState = S['KeysState'];
export type RecoveryBlob = S['RecoveryBlob'];
export type Pairing = S['Pairing'];
export type PairingPeer = S['PairingPeer'];
export type PairingStatus = S['PairingStatus'];
export type HistoryPage = S['HistoryPage'];
export type RemoteHistoryEntry = S['HistoryEntry'];
export type HistoryEntryRequest = S['HistoryEntryRequest'];
export type KeysSetupRequest = S['KeysSetupRequest'];
export type KeysRotateRequest = S['KeysRotateRequest'];
export type PairingWrapRequest = S['PairingWrapRequest'];
export type DeviceSession = S['DeviceSession'];
export type ChainLink = S['ChainLink'];

/** Typed calls for docs/API.md §2.4 over the device client (bearer token, stale-token retry). */
export function accountApi(client: DeviceClient) {
  const r = <T>(method: string, path: string, body?: unknown) => client.request<T>(method, path, body);
  const seg = encodeURIComponent;
  return {
    signUp: (email: string, password: string) =>
      r<AuthResult>('POST', '/v1/auth/signup', { email, password, add_device: false, copy_history: false }),
    signIn: (email: string, password: string) =>
      r<AuthResult>('POST', '/v1/auth/signin', { email, password, add_device: false, copy_history: false }),
    signOut: () => r<DeviceSession>('POST', '/v1/auth/signout'),
    requestReset: (email: string) =>
      client.publicRequest<undefined>('POST', '/v1/auth/password-reset/request', { email }),
    confirmReset: (token: string, password: string) =>
      client.publicRequest<undefined>('POST', '/v1/auth/password-reset/confirm', { token, password }),
    me: () => r<Me>('GET', '/v1/me'),
    setHistorySync: (on: boolean) => r<Me>('PATCH', '/v1/me', { history_sync: on }),
    changePassword: (current: string, next: string) =>
      r<undefined>('POST', '/v1/me/password', { current_password: current, new_password: next }),
    addCurrent: (copyHistory: boolean) =>
      r<AccountToken>('POST', '/v1/devices/current/add', { copy_history: copyHistory }),
    devices: () => r<{ devices: AccountDevice[] }>('GET', '/v1/devices'),
    renameDevice: (id: string, name: string) => r<AccountDevice>('PATCH', `/v1/devices/${seg(id)}`, { name }),
    revokeDevice: (id: string) => r<undefined>('DELETE', `/v1/devices/${seg(id)}`),
    keys: () => r<KeysState>('GET', '/v1/keys'),
    registerKey: (publicKey: string) => r<undefined>('PUT', '/v1/keys/device', { public_key: publicKey }),
    setupKeys: (req: KeysSetupRequest) => r<{ key_version: number }>('POST', '/v1/keys/setup', req),
    recovery: () => r<RecoveryBlob>('GET', '/v1/keys/recovery'),
    rotate: (req: KeysRotateRequest) => r<{ key_version: number }>('POST', '/v1/keys/rotate', req),
    chain: () => r<{ chain: ChainLink[] }>('GET', '/v1/keys/chain'),
    ackPending: (v: number) => r<undefined>('DELETE', `/v1/keys/pending/${v}`),
    createPairing: (ephemeralPublicKey: string) =>
      r<Pairing>('POST', '/v1/keys/pairings', { ephemeral_public_key: ephemeralPublicKey }),
    pairingStatus: (id: string) => r<PairingStatus>('GET', `/v1/keys/pairings/${seg(id)}`),
    lookupPairing: (code: string) => r<PairingPeer>('GET', `/v1/keys/pairings/by-code/${seg(code)}`),
    wrapPairing: (code: string, req: PairingWrapRequest) =>
      r<undefined>('POST', `/v1/keys/pairings/by-code/${seg(code)}/wrap`, req),
    historyEntries: (after: number, limit = 200) =>
      r<HistoryPage>('GET', `/v1/history/entries?after=${after}&limit=${limit}`),
    addHistoryEntry: (req: HistoryEntryRequest) => r<{ seq: number }>('POST', '/v1/history/entries', req),
    deleteHistoryEntry: (id: string) => r<undefined>('DELETE', `/v1/history/entries/${seg(id)}`),
    clearHistory: () => r<undefined>('DELETE', '/v1/history'),
  };
}

export type AccountApi = ReturnType<typeof accountApi>;
