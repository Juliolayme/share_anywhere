import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { renderApp } from '../test/render';
import { writePref } from '../lib/storage';

describe('guest-first shell (flags off)', () => {
  it('welcome (ON-1): first visit shows Welcome; Start sharing opens Transfer home with no sign-in anywhere', async () => {
    renderApp(<App />);
    expect(await screen.findByRole('heading', { name: 'Big files, any device, any network.' })).toBeInTheDocument();
    expect(screen.queryByText(/sign in/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start sharing' }));
    expect(await screen.findByRole('heading', { name: 'Transfer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });

  it('hides the Clipboard tab and shows Transfer, History, Devices, Settings', async () => {
    writePref('welcomed', '1');
    renderApp(<App />);
    const navs = await screen.findAllByRole('navigation', { name: 'Main navigation' });
    for (const nav of navs) {
      const links = within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent);
      expect(links).toEqual(['Transfer', 'History', 'Devices', 'Settings']);
    }
  });

  it('settings (ST-1): shows Guest and the device name with no Sign in button', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/settings' });
    expect(await screen.findByTestId('identity-label')).toHaveTextContent('Guest');
    await waitFor(() => expect(screen.getByTestId('settings-device-name')).toHaveTextContent('Calm Otter'));
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
  });

  it('language switch renders Vietnamese and persists', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/settings' });
    await userEvent.click(await screen.findByRole('radio', { name: 'Tiếng Việt' }));
    expect(await screen.findByRole('heading', { name: 'Cài đặt' })).toBeInTheDocument();
    expect(window.localStorage.getItem('sa.pref.lang')).toBe('vi');
  });
});

describe('with flags on', () => {
  it('shows the Clipboard tab only when the clipboard flag is on', async () => {
    vi.resetModules();
    vi.doMock('../config/flags', () => ({ flags: { sharing: false, accounts: false, clipboard: true } }));
    const { App: FlaggedApp } = await import('../App');
    const { renderApp: render2 } = await import('../test/render');
    const storage = await import('../lib/storage');
    storage.writePref('welcomed', '1');
    render2(<FlaggedApp />);
    const nav = (await screen.findAllByRole('navigation', { name: 'Main navigation' }))[0];
    expect(within(nav as HTMLElement).getByRole('link', { name: 'Clipboard' })).toBeInTheDocument();
    vi.doUnmock('../config/flags');
  });
});
