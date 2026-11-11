import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceClient } from '../../lib/api/device-client';
import { IdentityProvider } from '../../lib/identity/identity';
import { HistoryProvider } from '../history/HistoryContext';
import type { HistoryStore } from '../history/store/history-store';
import { ApiError } from '../../lib/api/errors';
import { writePref } from '../../lib/storage';
import { AccountProvider, keyErrorStatus, useAccount } from './AccountContext';

const wipe = vi.fn(async () => undefined);
type Fn<R> = (...args: unknown[]) => Promise<R>;
interface Check {
  status: string;
  keyVersion: number;
  state: object;
  newVersions: number[];
  rotationOwed: boolean;
}
const flow = vi.hoisted(() => ({
  checkKeys: vi.fn<Fn<Check>>(async () => ({
    status: 'pair',
    keyVersion: 1,
    state: {},
    newVersions: [],
    rotationOwed: false,
  })),
  rotateKeys: vi.fn<Fn<'rotated' | 'none'>>(async () => 'rotated'),
  rememberRevoked: vi.fn<Fn<undefined>>(async () => undefined),
  forgetRevoked: vi.fn<Fn<undefined>>(async () => undefined),
}));
vi.mock('./keyFlow', () => ({
  wipeAccountData: () => wipe(),
  checkKeys: flow.checkKeys,
  rotateKeys: flow.rotateKeys,
  rememberRevoked: flow.rememberRevoked,
  forgetRevoked: flow.forgetRevoked,
  rotationErrorStatus: () => null,
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

function setup(initial: object, { offline = false, meFailures = 0 } = {}) {
  const calls: string[] = [];
  let meLeft = meFailures;
  let claims = initial;
  const client = new DeviceClient({
    withLock: (fn) => fn(),
    setTimer: () => 0,
    clearTimer: () => undefined,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (offline) throw new TypeError('Failed to fetch');
      if (url === '/v1/devices/token') return json(200, sessionFor('d1', claims));
      if (url === '/v1/me' && meLeft > 0) {
        meLeft--;
        return json(500, { error: 'internal' });
      }
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
      if (url === '/v1/devices/d-gone' && init.method === 'DELETE') return new Response(null, { status: 204 });
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

beforeEach(() => {
  wipe.mockClear();
  flow.checkKeys.mockClear();
  flow.rotateKeys.mockClear();
  flow.rememberRevoked.mockClear();
  flow.forgetRevoked.mockClear();
});

describe('AccountProvider', () => {
  it('offline at load: unknown, with an account hint only when this browser held account keys (P2-7)', async () => {
    writePref('accountKeys', '1');
    const t = setup({}, { offline: true });
    await waitFor(() => expect(t.calls).toContain('POST /v1/devices/token'));
    expect(t.account().known).toBe(false);
    expect(t.account().accountHint).toBe(true);
    writePref('accountKeys', '');
  });

  it('offline at load without the marker gives no account hint', async () => {
    const t = setup({}, { offline: true });
    await waitFor(() => expect(t.calls).toContain('POST /v1/devices/token'));
    expect(t.account().known).toBe(false);
    expect(t.account().accountHint).toBe(false);
  });

  it('a failed GET /v1/me is reported (meError) and refreshMe loads it again (G.1)', async () => {
    const t = setup({ acct: 'u1' }, { meFailures: 1 });
    await waitFor(() => expect(t.account().meError).toBe(true));
    expect(t.account().me).toBeNull();
    await act(() => t.account().refreshMe());
    await waitFor(() => expect(t.account().me?.email).toBe('minh@example.com'));
    expect(t.account().meError).toBe(false);
  });

  it('maps key check failures to honest states', () => {
    expect(keyErrorStatus(new ApiError(409, 'keys_legacy', ''))).toBe('legacy');
    expect(keyErrorStatus(new ApiError(403, 'rotation_unauthorized', ''))).toBe('refused');
    expect(keyErrorStatus(new ApiError(403, 'device_key_unproven', ''))).toBe('refused');
    expect(keyErrorStatus(Object.assign(new Error('x'), { code: 'unverified' }))).toBe('rejected');
    expect(keyErrorStatus(Object.assign(new Error('x'), { code: 'storage_unavailable' }))).toBe('unavailable');
    expect(keyErrorStatus(new ApiError(500, 'internal', ''))).toBe('error');
  });

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

  it('open tabs check keys when shown again and on the 30 s tick, throttled to one per 30 s (I.3)', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const t = setup({ acct: 'u1', dl: true });
      await waitFor(() => expect(flow.checkKeys).toHaveBeenCalledTimes(1));
      expect(t.account().added).toBe(true);
      const show = () => act(() => void document.dispatchEvent(new Event('visibilitychange')));
      expect(document.visibilityState).toBe('visible');
      now += 10_000;
      await show();
      expect(flow.checkKeys).toHaveBeenCalledTimes(1); // within 30 s of the last check
      now += 25_000;
      let release: () => void = () => undefined;
      flow.checkKeys.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ status: 'ready', keyVersion: 2, state: {}, newVersions: [], rotationOwed: false });
          }),
      );
      await show();
      await waitFor(() => expect(flow.checkKeys).toHaveBeenCalledTimes(2));
      now += 40_000;
      await show(); // one already in flight
      expect(flow.checkKeys).toHaveBeenCalledTimes(2);
      await act(async () => release());
      await waitFor(() => expect(t.account().keys).toBe('ready'));
    } finally {
      clock.mockRestore();
    }
  });

  it('a background key check that cannot reach the server keeps the current state (I.3)', async () => {
    let now = 2_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      flow.checkKeys.mockImplementationOnce(async () => ({
        status: 'ready',
        keyVersion: 1,
        state: {},
        newVersions: [],
        rotationOwed: false,
      }));
      const t = setup({ acct: 'u1', dl: true });
      await waitFor(() => expect(t.account().keys).toBe('ready'));
      flow.checkKeys.mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      });
      now += 31_000;
      await act(() => void document.dispatchEvent(new Event('visibilitychange')));
      await waitFor(() => expect(flow.checkKeys).toHaveBeenCalledTimes(2));
      expect(t.account().keys).toBe('ready');
    } finally {
      clock.mockRestore();
    }
  });

  it('a rotation that finds this device without the newest key runs a key check, not the Retry banner (I.5)', async () => {
    const t = setup({ acct: 'u1', dl: true });
    await waitFor(() => expect(flow.checkKeys).toHaveBeenCalledTimes(1));
    flow.rotateKeys.mockImplementationOnce(async () => {
      throw Object.assign(new Error('key state: not_ready'), { name: 'KeyStateError', code: 'not_ready' });
    });
    let r: string | undefined;
    await act(async () => {
      r = await t.account().rotateKeys([]);
    });
    expect(r).toBe('failed');
    expect(flow.checkKeys).toHaveBeenCalledTimes(2);
    expect(t.account().rotationFailed).toBe(false);
  });

  it('revokeDevice remembers the device before revoking, then rotates with it excluded (I.4)', async () => {
    const t = setup({ acct: 'u1', dl: true });
    await waitFor(() => expect(flow.checkKeys).toHaveBeenCalled());
    flow.rememberRevoked.mockImplementationOnce(async () => void t.calls.push('remember'));
    flow.rotateKeys.mockImplementationOnce(async () => {
      t.calls.push('rotate');
      return 'rotated';
    });
    let r: string | undefined;
    await act(async () => {
      r = await t.account().revokeDevice('d-gone');
    });
    expect(r).toBe('rotated');
    expect(flow.rememberRevoked).toHaveBeenCalledWith('u1', ['d-gone'], expect.anything()); // the API, to read the account's version
    expect(t.calls.filter((c) => !c.startsWith('GET') && !c.includes('token'))).toEqual([
      'remember',
      'DELETE /v1/devices/d-gone',
      'rotate',
    ]);
    expect(flow.rotateKeys.mock.calls[0]?.slice(1)).toEqual(['u1', 'd1', ['d-gone']]);
    expect(flow.forgetRevoked).not.toHaveBeenCalled();

    // The server refuses the revoke (it answered, the device stays): it is not kept excluded.
    await expect(act(() => t.account().revokeDevice('d-other'))).rejects.toMatchObject({ code: 'not_found' });
    expect(flow.forgetRevoked).toHaveBeenCalledWith('u1', ['d-other']);
    expect(flow.rotateKeys).toHaveBeenCalledTimes(1);

    // Fails closed (QA round 8): if the account's key version cannot be read, nothing is revoked.
    flow.rememberRevoked.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    const before = t.calls.filter((c) => c.startsWith('DELETE')).length;
    await expect(act(() => t.account().revokeDevice('d-third'))).rejects.toThrow('offline');
    expect(t.calls.filter((c) => c.startsWith('DELETE')).length).toBe(before);
    expect(flow.rotateKeys).toHaveBeenCalledTimes(1);
  });
});
