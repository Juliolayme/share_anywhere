import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceClient } from '../../lib/api/device-client';
import { IdentityProvider } from '../../lib/identity/identity';
import { HistoryProvider } from '../history/HistoryContext';
import type { HistoryStore } from '../history/store/history-store';
import { AccountProvider, useAccount } from './AccountContext';

const wipe = vi.fn(async () => undefined);
vi.mock('./keyFlow', () => ({
  wipeAccountData: () => wipe(),
  checkKeys: vi.fn(async () => ({ status: 'pair', keyVersion: 1, state: {} })),
  keyStore: vi.fn(),
  syncMeta: () => ({ get: async (userId: string) => ({ userId }), put: async () => undefined }),
}));

const jwt = (payload: object) =>
  `h.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
const device = (id: string) => ({
  id,
  kind: 'anonymous',
  display_name: 'Web · Test',
  platform: 'Web · Test',
  created_at: '2026-11-10T00:00:00Z',
  last_seen_at: '2026-11-10T00:00:00Z',
});
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const sessionFor = (id: string, claims: object) => ({
  device: device(id),
  access_token: jwt({ sub: id, ...claims }),
  expires_in: 900,
  server_time: new Date().toISOString(),
});

function setup(initial: object) {
  const calls: string[] = [];
  let claims = initial;
  const client = new DeviceClient({
    withLock: (fn) => fn(),
    setTimer: () => 0,
    clearTimer: () => undefined,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url === '/v1/devices/token') return json(200, sessionFor('d1', claims));
      if (url === '/v1/me')
        return json(200, {
          id: 'u1',
          email: 'minh@example.com',
          created_at: '',
          device: { id: 'd1', added: false },
          history_sync: false,
        });
      if (url === '/v1/auth/signin')
        return json(200, { ...sessionFor('d1', { acct: 'u1' }), account: { id: 'u1', email: 'minh@example.com' } });
      if (url === '/v1/auth/signout') return json(200, sessionFor('d2', {}));
      return json(404, { error: 'not_found' });
    }) as unknown as typeof fetch,
  });
  const cleared = vi.fn(async () => undefined);
  const store: HistoryStore = {
    add: async () => undefined,
    list: async () => [],
    remove: async () => undefined,
    clear: cleared,
    sweep: async () => 0,
  };
  let api: ReturnType<typeof useAccount> | null = null;
  function Probe() {
    api = useAccount();
    return (
      <p data-testid="probe">
        {api.phase}|{api.me?.email ?? ''}|{api.added ? 'added' : 'not-added'}
      </p>
    );
  }
  render(
    <IdentityProvider client={client}>
      <HistoryProvider store={store}>
        <AccountProvider enabled>
          <Probe />
        </AccountProvider>
      </HistoryProvider>
    </IdentityProvider>,
  );
  return {
    client,
    calls,
    cleared,
    account: () => api as unknown as ReturnType<typeof useAccount>,
    setClaims: (c: object) => (claims = c),
  };
}

beforeEach(() => wipe.mockClear());

describe('AccountProvider', () => {
  it('a guest stays a guest and makes no account call', async () => {
    const t = setup({});
    await waitFor(() => expect(t.client.device?.id).toBe('d1'));
    expect(screen.getByTestId('probe')).toHaveTextContent('guest||not-added');
    expect(t.calls).toEqual(['POST /v1/devices/token']);
  });

  it('sign-in keeps the device ID and loads the account; sign-out wipes keys, clears history on request, new guest', async () => {
    const t = setup({});
    await waitFor(() => expect(t.client.device?.id).toBe('d1'));
    await act(() => t.account().signIn('signin', 'minh@example.com', 'Granite-Lantern-Orbit-7'));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('signed_in|minh@example.com|not-added'));
    expect(t.client.device?.id).toBe('d1');

    await act(() => t.account().signOut(true));
    expect(t.calls).toContain('POST /v1/auth/signout');
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(t.cleared).toHaveBeenCalledTimes(1);
    expect(t.client.device?.id).toBe('d2');
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('guest||not-added'));
  });

  it('keeps local history on sign-out when asked to', async () => {
    const t = setup({ acct: 'u1' });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('signed_in'));
    await act(() => t.account().signOut(false));
    expect(t.cleared).not.toHaveBeenCalled();
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it('erases local keys when the account session ends elsewhere (revoked, password reset)', async () => {
    const t = setup({ acct: 'u1', dl: true });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('signed_in'));
    t.setClaims({});
    await act(async () => {
      await t.client.refresh();
    });
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('probe')).toHaveTextContent('guest');
    expect(t.client.device?.id).toBe('d1');
  });
});
