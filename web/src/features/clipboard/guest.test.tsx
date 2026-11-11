import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { renderApp } from '../../test/render';
import { writePref } from '../../lib/storage';

// CB-1 (PRD §5.9): a guest who opens Clipboard sees the account-required intro, and the page makes no clipboard API
// call, no permission query and registers no copy listener; the clipboard runtime is not even loaded.
const loaded = vi.hoisted(() => ({ runtime: false }));
vi.mock('./runtime', async (importOriginal) => {
  loaded.runtime = true;
  return importOriginal();
});

const calls: string[] = [];
const spy = (name: string) =>
  vi.fn(async () => {
    calls.push(name);
    return '';
  });

describe('Clipboard as a guest (CB-1)', () => {
  let addDoc: ReturnType<typeof vi.spyOn>;
  let addWin: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    calls.length = 0;
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: spy('readText'), writeText: spy('writeText'), read: spy('read'), write: spy('write') },
    });
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: spy('permissions.query') },
    });
    addDoc = vi.spyOn(document, 'addEventListener');
    addWin = vi.spyOn(window, 'addEventListener');
  });
  afterEach(() => {
    addDoc.mockRestore();
    addWin.mockRestore();
  });

  it('shows the intro with Sign in and Create account returning to /clipboard, and touches no clipboard API', async () => {
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/clipboard' });
    expect(await screen.findByRole('heading', { name: 'Clipboard Sync' })).toBeInTheDocument();
    expect(screen.getByText('Sign in to sync your clipboard')).toBeInTheDocument();
    const signIn = screen.getAllByRole('link', { name: 'Sign in' }).map((a) => a.getAttribute('href'));
    expect(signIn).toContain('/signin?returnTo=%2Fclipboard');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/signup?returnTo=%2Fclipboard',
    );
    expect(screen.queryByRole('button', { name: 'Sync Clipboard' })).toBeNull();
    expect(document.querySelector('[data-screen="clipboard"]')).not.toBeNull();
    // Give any stray effect a chance to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    const listened = [...addDoc.mock.calls, ...addWin.mock.calls].map((c) => c[0]);
    expect(listened).not.toContain('copy');
    expect(listened).not.toContain('paste');
    expect(loaded.runtime).toBe(false);
  });

  it('Settings shows the Clipboard section disabled with Needs sign-in, and CB-6 is disabled with Sign in', async () => {
    writePref('welcomed', '1');
    const { unmount } = renderApp(<App />, { path: '/settings' });
    expect(await screen.findByText('Needs sign-in')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Automatic capture when permitted' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Skip sensitive content' })).toBeDisabled();
    unmount();
    renderApp(<App />, { path: '/settings/clipboard' });
    expect(await screen.findByRole('heading', { name: 'Clipboard settings' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Pause Clipboard Sync' })).toBeDisabled());
    expect(screen.getAllByRole('link', { name: 'Sign in' }).map((a) => a.getAttribute('href'))).toContain(
      '/signin?returnTo=%2Fsettings%2Fclipboard',
    );
    expect(calls).toEqual([]);
    expect(loaded.runtime).toBe(false);
  });

  it('plain HTTP: the intro says HTTPS is required', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    writePref('welcomed', '1');
    renderApp(<App />, { path: '/clipboard' });
    expect(await screen.findByTestId('cb-https-required')).toBeInTheDocument();
    expect(screen.getByText('HTTPS required')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});
