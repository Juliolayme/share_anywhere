import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAdk, openKeyStore } from '../../lib/crypto';
import type { DeviceClient } from '../../lib/api/device-client';
import type { ClipboardApi, ClipboardEventRequest, ClipboardSettings } from './api';
import { setAutoCapture } from './prefs';
import { createRuntime, settingsFromEvent, type ClipboardRuntime } from './runtime';
import { openClipboardStore } from './store';

// The runtime's browser side (PRD §7.2): automatic reads only on focus/visibility with permission already granted,
// manual reads from the click, in-page copies when automatic capture is on, permission state followed, no polling.
const clip = { text: 'from the clipboard', readCalls: 0, writes: [] as string[], fail: null as string | null };
let permission: { state: string; listeners: (() => void)[] } = { state: 'granted', listeners: [] };
let queryThrows = false;

function installBrowser() {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => {
        clip.readCalls++;
        if (clip.fail) throw new DOMException('blocked', clip.fail);
        return clip.text;
      },
      writeText: async (t: string) => {
        clip.writes.push(t);
      },
    },
  });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: async () => {
        if (queryThrows) throw new TypeError('clipboard-read is not a valid permission name');
        return {
          get state() {
            return permission.state;
          },
          addEventListener: (_: string, fn: () => void) => permission.listeners.push(fn),
          removeEventListener: () => undefined,
        };
      },
    },
  });
}

function fakeApi() {
  const posts: ClipboardEventRequest[] = [];
  let seq = 0;
  let settings: ClipboardSettings = { paused: false, retention_days: 7, sensitive_skip: true };
  const api: ClipboardApi = {
    history: async () => ({ events: [], cursor: seq }),
    events: async (cursor: number) => ({ events: [], next_cursor: cursor }),
    create: async (req) => {
      posts.push(req);
      seq++;
      return { seq, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400_000).toISOString() };
    },
    remove: async () => undefined,
    clear: async () => undefined,
    settings: async () => settings,
    saveSettings: async (s) => (settings = s),
  };
  return { api, posts };
}

async function runtime(): Promise<{ rt: ClipboardRuntime; posts: ClipboardEventRequest[] }> {
  const factory = new IDBFactory();
  const keys = await openKeyStore({ factory });
  await keys.saveAdk(1, generateAdk(1).raw);
  const { api, posts } = fakeApi();
  const rt = await createRuntime({
    client: {} as DeviceClient,
    userId: 'u1',
    deviceId: 'dev-a',
    onKeyConflict: async () => undefined,
    api,
    keys,
    store: openClipboardStore(factory),
    devices: async () => ({ devices: [{ id: 'dev-a', name: 'Desk' }] }),
  });
  await vi.waitFor(() => expect(rt.state().snapshot.settings).not.toBeNull());
  return { rt, posts };
}

let current: ClipboardRuntime | null = null;
beforeEach(() => {
  clip.text = 'from the clipboard';
  clip.readCalls = 0;
  clip.writes = [];
  clip.fail = null;
  permission = { state: 'granted', listeners: [] };
  queryThrows = false;
  setAutoCapture(true);
  installBrowser();
});
afterEach(() => {
  current?.stop();
  current = null;
});

const focus = () => window.dispatchEvent(new Event('focus'));

describe('clipboard runtime', () => {
  it('granted + automatic capture: one read per focus, sent encrypted; status auto', async () => {
    const { rt, posts } = await runtime();
    current = rt;
    expect(rt.state().status).toBe('auto');
    expect(clip.readCalls).toBe(0); // nothing is read at start: only on focus or visibility
    focus();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(clip.readCalls).toBe(1);
    expect(JSON.stringify(posts[0])).not.toContain('from the clipboard');
    // The same text again on the next focus is not sent twice.
    focus();
    await vi.waitFor(() => expect(clip.readCalls).toBe(2));
    expect(posts).toHaveLength(1);
  });

  it('permission not decided (prompt): focus never reads; the click does; status besteffort', async () => {
    permission.state = 'prompt';
    const { rt, posts } = await runtime();
    current = rt;
    expect(rt.state().status).toBe('besteffort');
    focus();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    expect(clip.readCalls).toBe(0);
    const read = await rt.readForSync();
    expect(read).toEqual({ ok: true, text: 'from the clipboard' });
    expect(clip.readCalls).toBe(1);
    expect(posts).toHaveLength(0); // reading does not send: the page decides (sensitive check, Sync anyway)
  });

  it('denied: a manual read reports denied and the status follows; focus still never reads (no prompt loop)', async () => {
    const { rt } = await runtime();
    current = rt;
    permission.state = 'denied';
    clip.fail = 'NotAllowedError';
    const read = await rt.readForSync();
    expect(read).toEqual({ ok: false, reason: 'denied' });
    expect(rt.state().status).toBe('denied');
    const before = clip.readCalls;
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(clip.readCalls).toBe(before);
  });

  it('Firefox/Safari (no clipboard-read permission name): unsupported, manual only', async () => {
    queryThrows = true;
    const { rt } = await runtime();
    current = rt;
    expect(rt.state().permission).toBe('unsupported');
    expect(rt.state().status).toBe('unsupported');
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(clip.readCalls).toBe(0);
  });

  it('follows a permission change made in the browser settings', async () => {
    permission.state = 'prompt';
    const { rt } = await runtime();
    current = rt;
    permission.state = 'granted';
    for (const l of permission.listeners) l();
    expect(rt.state().status).toBe('auto');
  });

  it('automatic capture off: no focus reads and no in-page copy capture; on: in-page copies are captured', async () => {
    const { rt, posts } = await runtime();
    current = rt;
    setAutoCapture(false);
    expect(rt.state().autoCapture).toBe(false);
    expect(rt.state().status).toBe('besteffort');
    focus();
    const p = document.createElement('p');
    p.textContent = 'selected words in the page';
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('copy'));
    await new Promise((r) => setTimeout(r, 20));
    expect(clip.readCalls).toBe(0);
    expect(posts).toHaveLength(0);
    setAutoCapture(true);
    document.dispatchEvent(new Event('copy'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    p.remove();
  });

  it('Copy writes the decrypted text with writeText and marks it as the clipboard text (not captured back)', async () => {
    const { rt, posts } = await runtime();
    current = rt;
    await rt.capture('copy me please', 'manual');
    const id = rt.state().snapshot.items[0]?.id ?? '';
    clip.text = 'copy me please';
    expect(await rt.copy(id)).toBe(true);
    expect(clip.writes).toEqual(['copy me please']);
    focus();
    await vi.waitFor(() => expect(clip.readCalls).toBe(1));
    expect(posts).toHaveLength(1);
  });

  it('stop() removes every listener: focus and copy do nothing afterwards', async () => {
    const { rt, posts } = await runtime();
    rt.stop();
    focus();
    document.dispatchEvent(new Event('copy'));
    await new Promise((r) => setTimeout(r, 20));
    expect(clip.readCalls).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('validates CLIPBOARD_SETTINGS_UPDATED payloads', () => {
    expect(
      settingsFromEvent({ type: 'CLIPBOARD_SETTINGS_UPDATED', paused: true, retention_days: 3, sensitive_skip: false }),
    ).toEqual({ paused: true, retention_days: 3, sensitive_skip: false });
    expect(settingsFromEvent({ type: 'CLIPBOARD_SETTINGS_UPDATED', paused: 'yes', retention_days: 3 })).toBeNull();
    expect(
      settingsFromEvent({ type: 'CLIPBOARD_SETTINGS_UPDATED', paused: true, retention_days: 9, sensitive_skip: true }),
    ).toBeNull();
  });

  it('settings pushed over the WebSocket apply without a request', async () => {
    const { rt } = await runtime();
    current = rt;
    rt.onSocket({ type: 'CLIPBOARD_SETTINGS_UPDATED', paused: true, retention_days: 2, sensitive_skip: true });
    expect(rt.state().status).toBe('paused');
    expect(rt.state().snapshot.settings?.retention_days).toBe(2);
  });
});
