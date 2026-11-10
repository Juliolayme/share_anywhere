import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import SendPicker from '../../pages/SendPicker';
import { I18nProvider, makeTranslate, type Locale } from '../../i18n/i18n';
import { IdentityProvider } from '../../lib/identity/identity';
import { ApiError } from '../../lib/api/errors';
import { fakeClient } from '../../test/render';
import { OpenSessionsPanel, sessionTitle } from './OpenSessionsPanel';
import { SharingProvider } from './SharingContext';
import type { OpenSession, OpenSessionList, SessionView } from './api';
import * as en from '../../i18n/catalog-en';

const NOW = Date.now();

function open(over: Partial<OpenSession> = {}): OpenSession {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'WAITING',
    created_at: new Date(NOW - 5 * 60_000).toISOString(),
    expires_at: new Date(NOW + 86_400_000).toISOString(),
    file_count: 1,
    total_bytes: 10,
    first_file_name: 'trip.mp4',
    capacity: { joined: 0, requested: 0, max: 5 },
    join_window: {
      state: 'OPEN',
      opened_at: new Date(NOW - 5 * 60_000).toISOString(),
      ends_at: new Date(NOW + 5 * 60_000).toISOString(),
      seq: 1,
    },
    ...over,
  };
}

const list = (sessions: OpenSession[]): OpenSessionList => ({
  sessions,
  max_open: 2,
  server_time: new Date(NOW).toISOString(),
});

const two = [
  open(),
  open({
    id: '22222222-2222-4222-8222-222222222222',
    status: 'ACTIVE',
    first_file_name: 'deck.pdf',
    file_count: 3,
    capacity: { joined: 2, requested: 0, max: 5 },
    join_window: {
      state: 'EXPIRED',
      opened_at: new Date(NOW - 20 * 60_000).toISOString(),
      ends_at: new Date(NOW - 10 * 60_000).toISOString(),
      seq: 1,
    },
  }),
];

function SessionRoute() {
  return <div data-testid="session-route">{useParams().id}</div>;
}

function renderWith(api: Record<string, unknown>, ui = <OpenSessionsPanel />, path = '/send') {
  const socket = { subscribe: () => () => undefined, send: () => true, stop: () => undefined } as never;
  return render(
    <I18nProvider initial="en">
      <IdentityProvider client={fakeClient()}>
        <SharingProvider api={api as never} socket={socket}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/send" element={ui} />
              <Route path="/send/session/:id" element={<SessionRoute />} />
            </Routes>
          </MemoryRouter>
        </SharingProvider>
      </IdentityProvider>
    </I18nProvider>,
  );
}

describe('sessionTitle', () => {
  const t = makeTranslate(en as never);
  it('uses the first file name and the number of further files', () => {
    expect(sessionTitle(t, { first_file_name: 'a.txt', file_count: 1 })).toBe('a.txt');
    expect(sessionTitle(t, { first_file_name: 'a.txt', file_count: 2 })).toBe('a.txt + 1 file');
    expect(sessionTitle(t, { first_file_name: 'a.txt', file_count: 4 })).toBe('a.txt + 3 files');
  });
});

describe('open sessions panel', () => {
  it('shows loading, then lists each session with receivers and code state', async () => {
    let resolve!: (l: OpenSessionList) => void;
    renderWith({ listOpen: vi.fn(() => new Promise<OpenSessionList>((r) => (resolve = r))) });
    expect(await screen.findByText('Loading your open sessions…')).toBeInTheDocument();
    resolve(list(two));
    const rows = await screen.findAllByTestId('open-session');
    expect(screen.getByRole('region', { name: 'Your open sessions' })).toBeInTheDocument();
    expect(screen.getByText(/can keep 2 sessions open/)).toBeInTheDocument();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('trip.mp4');
    expect(rows[0]).toHaveTextContent('Started 5 minutes ago');
    expect(rows[0]).toHaveTextContent('0/5 receivers');
    expect(rows[0]).toHaveTextContent('Code open until');
    expect(rows[1]).toHaveTextContent('deck.pdf + 2 files');
    expect(rows[1]).toHaveTextContent('2/5 receivers');
    expect(rows[1]).toHaveTextContent('Code expired');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('Open goes to the session screen', async () => {
    renderWith({ listOpen: vi.fn().mockResolvedValue(list(two)) });
    await userEvent.click(await screen.findByRole('button', { name: 'Open deck.pdf + 2 files' }));
    expect(screen.getByTestId('session-route')).toHaveTextContent('22222222-2222-4222-8222-222222222222');
  });

  it('Close confirms, closes, refreshes the list and reports the freed slot', async () => {
    const listOpen = vi
      .fn()
      .mockResolvedValueOnce(list(two))
      .mockResolvedValueOnce(list(two.slice(1)));
    const close = vi.fn().mockResolvedValue({ status: 'CLOSED' });
    const onClosed = vi.fn();
    renderWith({ listOpen, close }, <OpenSessionsPanel onClosed={onClosed} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Close trip.mp4' }));
    const dialog = screen.getByRole('dialog', { name: 'Close this session?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(screen.getAllByTestId('open-session')).toHaveLength(1));
    expect(close).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('open-sessions-closed')).toHaveTextContent('Session closed');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed close stays listed with an error; Cancel closes nothing', async () => {
    const close = vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'x'));
    renderWith({ listOpen: vi.fn().mockResolvedValue(list(two)), close });
    await userEvent.click(await screen.findByRole('button', { name: 'Close trip.mp4' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Close trip.mp4' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close session' }));
    expect(await screen.findByText('Couldn’t close the session. Try again.')).toBeInTheDocument();
    expect(screen.getAllByTestId('open-session')).toHaveLength(2);
  });

  it('error state retries; empty state says Create can go ahead', async () => {
    const listOpen = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(list([]));
    renderWith({ listOpen });
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your open sessions.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('open-sessions-empty')).toHaveTextContent('No sessions are open now');
  });

  it('renders Vietnamese strings', async () => {
    const vi_: Locale = 'vi';
    render(
      <I18nProvider initial={vi_}>
        <IdentityProvider client={fakeClient()}>
          <SharingProvider api={{ listOpen: vi.fn().mockResolvedValue(list(two)) } as never} socket={{} as never}>
            <MemoryRouter>
              <OpenSessionsPanel />
            </MemoryRouter>
          </SharingProvider>
        </IdentityProvider>
      </I18nProvider>,
    );
    expect(await screen.findByRole('region', { name: 'Các phiên đang mở của bạn' })).toBeInTheDocument();
    expect(screen.getAllByTestId('open-session')[1]).toHaveTextContent('2/5 người nhận');
  });
});

describe('send screen at the open-session cap', () => {
  it('Create → 409 shows the panel; after closing one, Create succeeds', async () => {
    const view = { id: '33333333-3333-4333-8333-333333333333' } as SessionView;
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'too_many_open_sessions', 'Close an open session'))
      .mockResolvedValueOnce(view);
    const listOpen = vi
      .fn()
      .mockResolvedValueOnce(list(two))
      .mockResolvedValueOnce(list(two.slice(1)));
    const close = vi.fn().mockResolvedValue({ status: 'CLOSED' });
    renderWith({ create, listOpen, close }, <SendPicker />);
    await userEvent.upload(screen.getByTestId('file-input'), new File(['hello'], 'new.txt', { type: 'text/plain' }));
    const createBtn = screen.getByRole('button', { name: /Create share session/ });
    await waitFor(() => expect(createBtn).toBeEnabled());
    await userEvent.click(createBtn);
    expect(await screen.findByRole('alert')).toHaveTextContent('Close one of your open sessions');
    expect(await screen.findAllByTestId('open-session')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Close trip.mp4' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(screen.getAllByTestId('open-session')).toHaveLength(1));
    expect(screen.queryByText('Close one of your open sessions before starting another.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Create share session/ }));
    expect(await screen.findByTestId('session-route')).toHaveTextContent(view.id);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
