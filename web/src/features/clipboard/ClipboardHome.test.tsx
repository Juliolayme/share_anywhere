import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAdk, openKeyStore } from '../../lib/crypto';
import type { DeviceClient } from '../../lib/api/device-client';
import { ApiError, NetworkError } from '../../lib/api/errors';
import { renderApp } from '../../test/render';
import type { ClipboardApi, ClipboardEventRequest, ClipboardSettings } from './api';
import ClipboardHome from './ClipboardHome';
import { setAutoCapture } from './prefs';
import { createRuntime } from './runtime';
import { openClipboardStore } from './store';

// CB-4 / CB-5 critical flows with the real runtime and engine over a fake API (docs/UX_SCREEN_MAP.md §10).
const browser = { text: 'hello from the test', fail: null as string | null, perm: 'prompt', writes: [] as string[] };

beforeEach(() => {
  browser.text = 'hello from the test';
  browser.fail = null;
  browser.perm = 'prompt';
  browser.writes = [];
  setAutoCapture(true);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => {
        if (browser.fail) throw new DOMException('no', browser.fail);
        return browser.text;
      },
      writeText: async (t: string) => {
        if (browser.fail) throw new DOMException('no', browser.fail);
        browser.writes.push(t);
      },
    },
  });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: async () => ({
        state: browser.perm,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    },
  });
});

async function setup(settings: Partial<ClipboardSettings> = {}, over: Partial<ClipboardApi> = {}) {
  const factory = new IDBFactory();
  const keys = await openKeyStore({ factory });
  await keys.saveAdk(1, generateAdk(1).raw);
  const posts: ClipboardEventRequest[] = [];
  let seq = 0;
  let current: ClipboardSettings = { paused: false, retention_days: 7, sensitive_skip: true, ...settings };
  const api: ClipboardApi = {
    history: async () => ({ events: [], cursor: 0 }),
    events: async (cursor) => ({ events: [], next_cursor: cursor }),
    create: async (req) => {
      posts.push(req);
      seq++;
      return { seq, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400_000).toISOString() };
    },
    remove: async () => undefined,
    clear: async () => undefined,
    settings: async () => current,
    saveSettings: async (s) => (current = s),
    ...over,
  };
  const rt = await createRuntime({
    client: {} as DeviceClient,
    userId: 'u1',
    deviceId: '6f1c2c1e-1111-4a5b-9c9d-000000000001',
    onKeyConflict: async () => undefined,
    api,
    keys,
    store: openClipboardStore(factory),
    devices: async () => ({ devices: [] }),
  });
  await vi.waitFor(() => expect(rt.state().snapshot.settings).not.toBeNull());
  renderApp(
    <Routes>
      <Route path="/clipboard/*" element={<ClipboardHome runtime={rt} />} />
    </Routes>,
    { path: '/clipboard' },
  );
  return { rt, posts };
}

describe('Clipboard home (CB-4)', () => {
  it('empty state, best-effort status, then Sync reads in the click and shows the item', async () => {
    const { posts } = await setup();
    expect(await screen.findByTestId('cb-empty')).toHaveTextContent('Nothing synced yet');
    expect(screen.getByTestId('cb-status')).toHaveAttribute('data-status', 'besteffort');
    expect(screen.getByTestId('cb-status-title')).toHaveTextContent('Automatic capture is best-effort');
    await userEvent.click(screen.getByRole('button', { name: 'Sync Clipboard' }));
    expect(await screen.findByTestId('cb-item-text')).toHaveTextContent('hello from the test');
    expect(await screen.findByText('Clipboard synced · encrypted')).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(within(screen.getByTestId('cb-item')).getByText('This browser')).toBeInTheDocument();
  });

  it('possibly sensitive text: skipped with the disclaimer; "Sync anyway" sends it', async () => {
    const { posts } = await setup();
    browser.text = '482913';
    await userEvent.click(await screen.findByRole('button', { name: 'Sync Clipboard' }));
    expect(await screen.findByTestId('cb-sensitive')).toHaveTextContent('best-effort');
    expect(posts).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Sync anyway' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(await screen.findByTestId('cb-item-text')).toHaveTextContent('482913');
  });

  it('a refused read opens the paste fallback; the pasted text syncs and the browser is not asked again', async () => {
    const { posts } = await setup();
    browser.fail = 'NotAllowedError';
    browser.perm = 'denied';
    await userEvent.click(await screen.findByRole('button', { name: 'Sync Clipboard' }));
    const form = await screen.findByTestId('cb-paste');
    expect(form).toHaveTextContent('Clipboard permission denied');
    await waitFor(() => expect(screen.getByTestId('cb-status')).toHaveAttribute('data-status', 'denied'));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Text to sync' }), 'typed instead');
    await userEvent.click(within(form).getByRole('button', { name: 'Sync this text' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('cb-paste')).toBeNull());
    expect(await screen.findByTestId('cb-item-text')).toHaveTextContent('typed instead');
  });

  it('pause and resume (account setting), and the automatic capture switch (this browser)', async () => {
    await setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Pause sync' }));
    await waitFor(() => expect(screen.getByTestId('cb-status')).toHaveAttribute('data-status', 'paused'));
    await userEvent.click(screen.getByRole('button', { name: 'Sync Clipboard' }));
    expect(await screen.findByText('Resume sync first')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume sync' }));
    await waitFor(() => expect(screen.getByTestId('cb-status')).toHaveAttribute('data-status', 'besteffort'));
    const sw = screen.getByRole('switch', { name: 'Automatic capture when permitted' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('cb-status-title')).toHaveTextContent('Manual capture');
  });

  it('item detail: full text, Copy writes it, Delete removes it; search filters', async () => {
    const { rt } = await setup();
    await rt.capture('first item text', 'manual');
    await rt.capture('second item about apples', 'manual');
    expect(await screen.findAllByTestId('cb-item')).toHaveLength(2);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search clipboard' }), 'apples');
    expect(screen.getAllByTestId('cb-item')).toHaveLength(1);
    await userEvent.click(screen.getByText('second item about apples'));
    const detail = await screen.findByTestId('cb-detail');
    expect(within(detail).getByTestId('cb-detail-text')).toHaveTextContent('second item about apples');
    await userEvent.click(within(detail).getByRole('button', { name: 'Copy' }));
    expect(browser.writes).toEqual(['second item about apples']);
    await userEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByTestId('cb-detail')).toBeNull());
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search clipboard' }));
    expect(screen.getAllByTestId('cb-item')).toHaveLength(1);
  });

  it('first load offline with nothing cached: the offline state, not "No clipboard items yet"; Sync says offline', async () => {
    await setup(
      {},
      {
        history: async () => {
          throw new NetworkError();
        },
        create: async () => {
          throw new NetworkError();
        },
      },
    );
    const offline = await screen.findByTestId('cb-offline');
    expect(offline).toHaveTextContent('You’re offline');
    expect(offline).toHaveTextContent('loads when you reconnect');
    expect(screen.queryByTestId('cb-empty')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sync Clipboard' }));
    expect(await screen.findByText('Encrypted and queued — will send when online')).toBeInTheDocument();
    // The queued row replaces the offline state.
    expect(await screen.findByTestId('cb-item-text')).toHaveTextContent('hello from the test');
    expect(screen.queryByTestId('cb-offline')).toBeNull();
  });

  it('first load failing with nothing cached: the error state with Retry, then the real empty state', async () => {
    let fail = true;
    await setup(
      {},
      {
        history: async () => {
          if (fail) throw new ApiError(500, 'internal', 'boom');
          return { events: [], cursor: 0 };
        },
      },
    );
    const error = await screen.findByTestId('cb-load-error');
    expect(error).toHaveTextContent('Couldn’t load your clipboard history.');
    expect(screen.queryByTestId('cb-empty')).toBeNull();
    fail = false;
    await userEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('cb-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('cb-load-error')).toBeNull();
  });

  it('the queued toast states the real cause: server busy (5xx) or rate limited (429), not "offline"', async () => {
    const failures = [new ApiError(503, 'unavailable', 'busy'), new ApiError(429, 'rate_limited', 'slow down', 30)];
    await setup(
      {},
      {
        create: async () => {
          throw failures.shift() ?? new ApiError(503, 'unavailable', 'busy');
        },
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Sync Clipboard' }));
    expect(await screen.findByText(/the server is busy right now/)).toBeInTheDocument();
    expect(screen.queryByText('Encrypted and queued — will send when online')).toBeNull();
    browser.text = 'second text';
    await userEvent.click(screen.getByRole('button', { name: 'Sync Clipboard' }));
    expect(await screen.findByText(/too many items at once\. It will be sent again shortly/)).toBeInTheDocument();
    expect(screen.queryByText('Encrypted and queued — will send when online')).toBeNull();
  });
});
