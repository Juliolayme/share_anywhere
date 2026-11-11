import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { I18nProvider } from '../i18n/i18n';
import { IdentityProvider } from '../lib/identity/identity';
import { HistoryProvider } from '../features/history/HistoryContext';
import { ToastProvider } from '../components/Toast';
import { DeviceClient } from '../lib/api/device-client';
import type { HistoryStore } from '../features/history/store/history-store';
import { SharingProvider } from '../features/sharing/SharingContext';
import { KeepAwakeProvider } from '../lib/keepAwake/KeepAwakeContext';
import type { KeepAwakeEnv } from '../lib/keepAwake/controller';
import { AccountProvider } from '../features/account/AccountContext';

export const noWakeLock: KeepAwakeEnv = { isSecure: true, isVisible: () => true, onVisibility: () => () => undefined };

export const testDevice = {
  id: '6f1c2c1e-1111-4a5b-9c9d-000000000001',
  kind: 'anonymous',
  display_name: 'Web · Chrome · Calm Otter',
  platform: 'Web · Chrome',
  created_at: '2026-11-10T00:00:00Z',
  last_seen_at: '2026-11-10T00:00:00Z',
};

/** A DeviceClient backed by an in-memory fake server. */
export function fakeClient(over: { failWith?: Response } = {}) {
  let name = testDevice.display_name;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const session = () => ({
    device: { ...testDevice, display_name: name },
    access_token: 't',
    expires_in: 900,
    server_time: new Date().toISOString(),
  });
  return new DeviceClient({
    withLock: (fn) => fn(),
    setTimer: () => 0,
    clearTimer: () => undefined,
    fetch: (async (url: string, init: RequestInit) => {
      if (over.failWith) return over.failWith.clone();
      if (url === '/v1/devices/token') return json(200, session());
      if (url === '/v1/devices/current' && init.method === 'PATCH') {
        name = JSON.parse(String(init.body)).display_name;
        return json(200, session().device);
      }
      return json(404, { error: 'not_found' });
    }) as unknown as typeof fetch,
  });
}

export const emptyStore: HistoryStore = {
  add: async () => undefined,
  list: async () => [],
  remove: async () => undefined,
  clear: async () => undefined,
  sweep: async () => 0,
};

export function renderApp(
  ui: ReactElement,
  {
    path = '/',
    client = fakeClient(),
    store = emptyStore,
  }: { path?: string; client?: DeviceClient; store?: HistoryStore | null } = {},
) {
  return render(
    <I18nProvider initial="en">
      <IdentityProvider client={client}>
        <SharingProvider>
          <KeepAwakeProvider env={noWakeLock}>
            <HistoryProvider store={store}>
              <AccountProvider>
                <ToastProvider>
                  <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
                </ToastProvider>
              </AccountProvider>
            </HistoryProvider>
          </KeepAwakeProvider>
        </SharingProvider>
      </IdentityProvider>
    </I18nProvider>,
  );
}
