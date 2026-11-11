import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { I18nProvider } from '../../i18n/i18n';
import { IdentityProvider } from '../../lib/identity/identity';
import { fakeClient } from '../../test/render';
import type { AccountValue } from './AccountContext';
import AccountDevices from './AccountDevices';
import AccountSettings from './AccountSettings';
import { SyncBanner } from './SyncBanner';

/**
 * Account UI states (docs/UX_SCREEN_MAP.md HI-1, DV-1, ST-1; QA round 1 P1-2, P2-3, P2-7 and the key authenticity
 * error state) with a stubbed account context.
 */
let account: AccountValue;
vi.mock('./AccountContext', async (original) => ({
  ...(await original<typeof import('./AccountContext')>()),
  useAccount: () => account,
}));

const devices = [
  {
    id: 'd-1',
    name: 'Desk',
    platform: 'Web · Chrome',
    added: true,
    current: true,
    last_seen_at: '2026-11-10T00:00:00Z',
    created_at: '2026-11-10T00:00:00Z',
    has_key: true,
  },
  {
    id: 'd-2',
    name: 'Phone',
    platform: 'Android',
    added: true,
    current: false,
    last_seen_at: '2026-11-10T00:00:00Z',
    created_at: '2026-11-10T00:00:00Z',
    has_key: true,
  },
];

function makeAccount(over: Partial<AccountValue> = {}): AccountValue {
  return {
    enabled: true,
    known: true,
    accountHint: false,
    phase: 'signed_in',
    userId: 'u1',
    me: {
      id: 'u1',
      email: 'minh@example.com',
      created_at: '2026-11-10T00:00:00Z',
      device: { id: 'd-1', added: true },
      history_sync: true,
    },
    added: true,
    keys: 'ready',
    keyVersion: 1,
    sync: { state: 'idle' },
    api: { devices: vi.fn(async () => ({ devices })) } as unknown as AccountValue['api'],
    signIn: vi.fn(),
    addDevice: vi.fn(),
    signOut: vi.fn(),
    setHistorySync: vi.fn(async () => undefined),
    changePassword: vi.fn(),
    refreshKeys: vi.fn(async () => 'ready' as const),
    syncNow: vi.fn(async () => undefined),
    ...over,
  };
}

function show(ui: ReactElement) {
  return render(
    <I18nProvider initial="en">
      <IdentityProvider client={fakeClient()}>
        <ToastProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ToastProvider>
      </IdentityProvider>
    </I18nProvider>,
  );
}

const href = (name: string | RegExp) => screen.getByRole('link', { name }).getAttribute('href');

beforeEach(() => {
  account = makeAccount();
});

describe('History SyncBanner', () => {
  it('a failed key check shows an error with Retry that re-runs the key check (P1-2)', async () => {
    account = makeAccount({ keys: 'error' });
    show(<SyncBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t check this device’s encryption key.');
    expect(screen.queryByText('Syncing…')).toBeNull();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(account.refreshKeys).toHaveBeenCalledTimes(1);
    expect(account.syncNow).not.toHaveBeenCalled();
  });

  it('while the key check runs it says so, never "Syncing…"', () => {
    account = makeAccount({ keys: 'checking' });
    show(<SyncBanner />);
    expect(screen.getByTestId('sync-checking')).toHaveTextContent('Checking this device’s encryption key…');
    expect(screen.queryByText('Syncing…')).toBeNull();
  });

  it('an account without a key links to key setup, not to pairing', () => {
    account = makeAccount({ keys: 'setup', keyVersion: 0 });
    show(<SyncBanner />);
    expect(screen.getByText('Set up encryption on this device to sync history.')).toBeInTheDocument();
    expect(href('Set up encryption')).toBe('/account/key/setup?returnTo=%2Fhistory');
    expect(screen.queryByRole('link', { name: 'Pair this device' })).toBeNull();
  });

  it('a device without the account key links to pairing', () => {
    account = makeAccount({ keys: 'pair' });
    show(<SyncBanner />);
    expect(href('Pair this device')).toBe('/account/key/pair?returnTo=%2Fhistory');
  });

  it('offline at load with an account marker shows a neutral state, not the guest prompt (P2-7)', () => {
    account = makeAccount({ known: false, accountHint: true, phase: 'guest', added: false, me: null, keys: 'none' });
    show(<SyncBanner />);
    expect(screen.getByTestId('sync-unknown')).toHaveTextContent('Can’t reach your account right now.');
    expect(screen.queryByTestId('history-signin')).toBeNull();
  });

  it('a guest (no account marker) sees Sign in to sync', () => {
    account = makeAccount({ known: false, phase: 'guest', added: false, me: null, keys: 'none' });
    show(<SyncBanner />);
    expect(screen.getByTestId('history-signin')).toBeInTheDocument();
  });

  it('a rejected key change shows the error with Pair again and Use recovery phrase', () => {
    account = makeAccount({ keys: 'rejected' });
    show(<SyncBanner />);
    expect(screen.getByRole('alert')).toHaveTextContent('A key change on your account could not be verified');
    expect(href('Pair again')).toBe('/account/key/pair?returnTo=%2Fhistory');
    expect(href('Use recovery phrase')).toBe('/account/key/pair?mode=phrase&returnTo=%2Fhistory');
  });

  it('legacy keys are stated honestly', () => {
    account = makeAccount({ keys: 'legacy' });
    show(<SyncBanner />);
    expect(screen.getByTestId('keys-legacy')).toHaveTextContent('must be set up again');
  });

  it('a ready device with sync on shows the sync status', () => {
    account = makeAccount({ sync: { state: 'ok', at: Date.now(), unreadable: 0 } });
    show(<SyncBanner />);
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Synced');
  });
});

describe('not-added sessions are read-only (B.3)', () => {
  it('Devices: no rename or revoke controls, no pairing, the Add this device prompt instead', async () => {
    account = makeAccount({ added: false, keys: 'none' });
    show(<AccountDevices />);
    await waitFor(() => expect(screen.getAllByTestId('account-device')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Revoke/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pair a new device' })).toBeNull();
    expect(screen.getByTestId('devices-add-device')).toHaveAttribute('href', '/signin/choices?returnTo=%2Fdevices');
  });

  it('Settings: no history sync switch or key row, the Add this device prompt instead', () => {
    account = makeAccount({ added: false, keys: 'none' });
    show(<AccountSettings />);
    expect(screen.queryByRole('switch', { name: 'Sync transfer history' })).toBeNull();
    expect(screen.queryByTestId('key-status')).toBeNull();
    expect(screen.getByTestId('settings-add-device')).toBeInTheDocument();
  });

  it('an added device keeps rename and the history sync switch', async () => {
    show(<AccountDevices />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Phone' })).toBeInTheDocument());
    show(<AccountSettings />);
    expect(screen.getByRole('switch', { name: 'Sync transfer history' })).toBeEnabled();
  });
});

describe('key change that could not be verified (Devices, Settings)', () => {
  it('Devices shows the error with Pair again / Use recovery phrase', async () => {
    account = makeAccount({ keys: 'rejected' });
    show(<AccountDevices />);
    expect(screen.getByTestId('key-change-unverified')).toBeInTheDocument();
    expect(href('Pair again')).toBe('/account/key/pair?returnTo=%2Fdevices');
    expect(href('Use recovery phrase')).toBe('/account/key/pair?mode=phrase&returnTo=%2Fdevices');
    await waitFor(() => expect(screen.getAllByTestId('account-device')).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Pair a new device' })).toBeDisabled();
  });

  it('Settings shows it in the key row', () => {
    account = makeAccount({ keys: 'rejected' });
    show(<AccountSettings />);
    expect(within(screen.getByTestId('key-status')).getByRole('alert')).toHaveTextContent(
      'A key change on your account could not be verified',
    );
    expect(href('Pair again')).toBe('/account/key/pair?returnTo=%2Fsettings');
  });
});
