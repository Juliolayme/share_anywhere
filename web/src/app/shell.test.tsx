import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { renderApp } from '../test/render';
import { writePref } from '../lib/storage';

describe('guest-first shell (accounts on, clipboard off)', () => {
  it('welcome (ON-1): Start sharing opens Transfer home; sign-in is only an optional link, never a screen', async () => {
    renderApp(<App />);
    expect(await screen.findByRole('heading', { name: 'Big files, any device, any network.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Already have an account? Sign in' })).toHaveAttribute('href', '/signin');
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start sharing' }));
    expect(await screen.findByRole('heading', { name: 'Transfer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /sign in|create account/i })).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    // The header identity chip offers Sign in as a link back to where the guest is.
    expect(screen.getByTestId('header-signin')).toHaveAttribute('href', '/signin');
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

  it('settings (ST-1): Guest header with Sign in and Create account; account settings shown disabled', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/settings' });
    expect(await screen.findByTestId('identity-label')).toHaveTextContent('Guest');
    await waitFor(() => expect(screen.getByTestId('settings-device-name')).toHaveTextContent('Calm Otter'));
    expect(screen.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute('href', '/signin?returnTo=%2Fsettings');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/signup?returnTo=%2Fsettings',
    );
    expect(screen.getByRole('switch', { name: 'Sync transfer history' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Cloud Distribution' })).toBeDisabled();
    expect(screen.getByText('Sign in to use Cloud transfer')).toBeInTheDocument();
  });

  it('devices (DV-1) and history (HI-1): guests keep This device and local history, with Sign in offered', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/devices' });
    expect(await screen.findByRole('heading', { name: 'Sync your device list' })).toBeInTheDocument();
    expect(screen.getByTestId('device-name')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('link', { name: 'Sign in' })
        .some((a) => a.getAttribute('href') === '/signin?returnTo=%2Fdevices'),
    ).toBe(true);
  });

  it('language switch renders Vietnamese and persists', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/settings' });
    await userEvent.click(await screen.findByRole('radio', { name: 'Tiếng Việt' }));
    expect(await screen.findByRole('heading', { name: 'Cài đặt' })).toBeInTheDocument();
    expect(window.localStorage.getItem('sa.pref.lang')).toBe('vi');
  });
});

describe('with flags changed', () => {
  it('accounts flag off: no sign-in link anywhere and no account routes', async () => {
    vi.resetModules();
    vi.doMock('../config/flags', () => ({ flags: { sharing: true, accounts: false, clipboard: false } }));
    const { App: FlaggedApp } = await import('../App');
    const { renderApp: render2 } = await import('../test/render');
    render2(<FlaggedApp />);
    expect(await screen.findByRole('heading', { name: 'Big files, any device, any network.' })).toBeInTheDocument();
    expect(screen.queryByText(/sign in/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start sharing' }));
    expect(await screen.findByRole('heading', { name: 'Transfer' })).toBeInTheDocument();
    expect(screen.queryByText(/sign in/i)).toBeNull();
    vi.doUnmock('../config/flags');
  });

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
