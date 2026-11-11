import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionPage from './SessionPage';
import { I18nProvider } from '../../i18n/i18n';
import { IdentityProvider } from '../../lib/identity/identity';
import { SharingProvider } from '../../features/sharing/SharingContext';
import { KeepAwakeProvider } from '../../lib/keepAwake/KeepAwakeContext';
import { ToastProvider } from '../../components/Toast';
import { HistoryProvider } from '../../features/history/HistoryContext';
import { fakeClient, noWakeLock } from '../../test/render';
import { mmss, secondsUntil, serverOffset, type SessionView } from '../../features/sharing/api';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function view(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    role: 'sender',
    status: 'WAITING',
    require_approval: false,
    join_window: {
      state: 'OPEN',
      opened_at: new Date(NOW).toISOString(),
      ends_at: new Date(NOW + 600_000).toISOString(),
      seq: 1,
    },
    code: '482913',
    link_token: 'tok',
    join_url: 'http://localhost/j/AbCdEfGhIjKlMnOpQrStUvWx',
    capacity: { joined: 0, requested: 0, max: 5 },
    participants: [],
    files: [{ id: 'f1', name: 'a.mp4', size: 10, mime: 'video/mp4' }],
    total_bytes: 10,
    file_count: 1,
    protected_mode: false,
    expires_at: new Date(NOW + 86_400_000).toISOString(),
    server_time: new Date(NOW).toISOString(),
    ...over,
  };
}

function renderSession(api: Record<string, unknown>) {
  const socket = { subscribe: () => () => undefined, send: () => true, stop: () => undefined } as never;
  return render(
    <I18nProvider initial="en">
      <IdentityProvider client={fakeClient()}>
        <SharingProvider api={api as never} socket={socket}>
          <KeepAwakeProvider env={noWakeLock}>
            <HistoryProvider store={null}>
              <ToastProvider>
                <MemoryRouter initialEntries={['/send/session/s1']}>
                  <Routes>
                    <Route path="/send/session/:id" element={<SessionPage />} />
                  </Routes>
                </MemoryRouter>
              </ToastProvider>
            </HistoryProvider>
          </KeepAwakeProvider>
        </SharingProvider>
      </IdentityProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('countdown helpers', () => {
  it('follow the server clock, not only the local one', () => {
    const offset = serverOffset(new Date(NOW + 30_000).toISOString(), NOW); // server 30 s ahead
    expect(offset).toBe(30_000);
    expect(secondsUntil(new Date(NOW + 600_000).toISOString(), offset, NOW)).toBe(570);
    expect(secondsUntil(new Date(NOW - 1000).toISOString(), 0, NOW)).toBe(0);
    expect(mmss(600)).toBe('10:00');
    expect(mmss(59)).toBe('0:59');
  });
});

describe('session (TR-4/TR-5)', () => {
  it('shows the code, QR and link with a 10:00 countdown, and the keep-open banner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    renderSession({ get: vi.fn().mockResolvedValue(view()) });
    expect(await screen.findByTestId('session-code')).toHaveTextContent('482913');
    expect(screen.getByTestId('countdown')).toHaveTextContent('10:00');
    expect(screen.getByRole('img', { name: 'QR code to join this session' })).toBeInTheDocument();
    expect(screen.getByTestId('session-link')).toHaveTextContent('/j/');
    expect(await screen.findByTestId('keep-open-banner')).toBeInTheDocument();
    expect(screen.getByTestId('no-receivers')).toBeInTheDocument();
    expect(document.querySelector('[data-screen="session"]')).not.toBeNull();
  });

  it('expired: hides the code and offers Create new code, which restarts at 10:00', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW + 601_000);
    const expired = view({
      join_window: {
        state: 'EXPIRED',
        opened_at: new Date(NOW).toISOString(),
        ends_at: new Date(NOW + 600_000).toISOString(),
        seq: 1,
      },
      server_time: new Date(NOW + 601_000).toISOString(),
    });
    delete expired.code;
    delete expired.link_token;
    delete expired.join_url;
    const renewed = view({
      code: '135790',
      join_window: {
        state: 'OPEN',
        opened_at: new Date(NOW + 601_000).toISOString(),
        ends_at: new Date(NOW + 1_201_000).toISOString(),
        seq: 2,
      },
      server_time: new Date(NOW + 601_000).toISOString(),
    });
    const get = vi.fn().mockResolvedValueOnce(expired).mockResolvedValue(renewed);
    const renew = vi.fn().mockResolvedValue(renewed);
    renderSession({ get, renew });
    expect(await screen.findByTestId('code-expired')).toHaveTextContent('Code expired — Create new code');
    expect(screen.queryByTestId('session-code')).toBeNull();
    expect(document.querySelector('[data-screen="session-expired"]')).not.toBeNull();
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Create new code' }));
    });
    expect(renew).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(screen.getByTestId('session-code')).toHaveTextContent('135790'));
    expect(screen.getByTestId('countdown')).toHaveTextContent('10:00');
  });

  it('full: Create new code is disabled; receivers show badges and security words', async () => {
    const p = (i: number, status: 'JOINED' | 'REQUESTED') => ({
      id: `p${i}`,
      role: 'receiver' as const,
      status,
      display_name: `Device ${i}`,
      platform: 'Web · Firefox',
      signed_in: i === 0,
      security_words: ['maple', 'river', 'seven'],
      joined_via: 'code' as const,
    });
    const full = view({
      status: 'ACTIVE',
      join_window: {
        state: 'ENDED_FULL',
        opened_at: new Date(NOW).toISOString(),
        ends_at: new Date(NOW + 600_000).toISOString(),
        seq: 1,
      },
      capacity: { joined: 4, requested: 1, max: 5 },
      participants: [p(0, 'JOINED'), p(1, 'JOINED'), p(2, 'JOINED'), p(3, 'JOINED'), p(4, 'REQUESTED')],
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW + 1000);
    renderSession({ get: vi.fn().mockResolvedValue(full) });
    expect(await screen.findByRole('button', { name: 'Create new code' })).toBeDisabled();
    expect(screen.getAllByTestId('participant-card')).toHaveLength(4);
    expect(screen.getAllByTestId('request-card')).toHaveLength(1);
    expect(screen.getAllByTestId('security-words')[0]).toHaveTextContent('maple · river · seven');
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.getAllByText('Guest').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('slots')[0]).toHaveTextContent('5/5 · Session full');
    expect(document.querySelector('[data-screen="session-full"]')).not.toBeNull();
  });
});
