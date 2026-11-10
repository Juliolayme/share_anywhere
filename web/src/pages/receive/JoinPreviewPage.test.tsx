import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JoinPreviewPage, { type PreviewState } from './JoinPreviewPage';
import { I18nProvider } from '../../i18n/i18n';
import { IdentityProvider } from '../../lib/identity/identity';
import { SharingProvider } from '../../features/sharing/SharingContext';
import { fakeClient } from '../../test/render';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function renderPreview(endsInMs: number, ticketInMs = endsInMs) {
  const state: PreviewState = {
    offset: 0,
    source: { code: '482913' },
    preview: {
      session_id: 's1',
      sender: { participant_id: 'p0', display_name: 'Minh’s laptop', platform: 'Web · Chrome', signed_in: false },
      files: [{ id: 'f1', name: 'a.mp4', size: 10, mime: 'video/mp4' }],
      total_bytes: 10,
      file_count: 1,
      require_approval: false,
      protected_mode: false,
      join_window_ends_at: new Date(NOW + endsInMs).toISOString(),
      join_ticket: 'tkt',
      join_ticket_expires_at: new Date(NOW + ticketInMs).toISOString(),
      via: 'code',
      server_time: new Date(NOW).toISOString(),
    },
  };
  const socket = { subscribe: () => () => undefined } as never;
  return render(
    <I18nProvider initial="en">
      <IdentityProvider client={fakeClient()}>
        <SharingProvider api={{} as never} socket={socket}>
          <MemoryRouter initialEntries={[{ pathname: '/join/preview', state }]}>
            <Routes>
              <Route path="/join/preview" element={<JoinPreviewPage />} />
            </Routes>
          </MemoryRouter>
        </SharingProvider>
      </IdentityProvider>
    </I18nProvider>,
  );
}

afterEach(() => vi.useRealTimers());

describe('receive-preview (RX-4)', () => {
  it('shows "Join within m:ss" only in the last minute of the join window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    renderPreview(45_000);
    expect(await screen.findByTestId('join-within')).toHaveTextContent('Join within 0:45');
    expect(screen.getByRole('button', { name: 'Receive' })).toBeEnabled();
  });

  it('no countdown hint earlier in the window; expired window shows the receiver message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { unmount } = renderPreview(300_000);
    expect(await screen.findByRole('button', { name: 'Receive' })).toBeInTheDocument();
    expect(screen.queryByTestId('join-within')).toBeNull();
    unmount();
    renderPreview(-1000);
    expect(await screen.findByRole('alert')).toHaveTextContent('Code expired — ask the sender for a new code');
    expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull();
  });

  it('a lapsed 5-minute ticket does not expire the preview while the window is open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    renderPreview(400_000, -1000);
    expect(await screen.findByRole('button', { name: 'Receive' })).toBeInTheDocument();
  });
});
