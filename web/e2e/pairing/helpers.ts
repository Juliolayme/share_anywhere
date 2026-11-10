import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type APIRequestContext,
} from '@playwright/test';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export type WakeMode = 'granted' | 'refused' | 'unsupported';

/** Installs a navigator.wakeLock recorder (docs/TESTING_AND_CI.md §3): window.__wl = { requests, releases }. */
export async function stubWakeLock(ctx: BrowserContext, mode: WakeMode) {
  await ctx.addInitScript((m: WakeMode) => {
    const rec = { requests: 0, releases: 0, mode: m };
    (window as unknown as { __wl: typeof rec }).__wl = rec;
    if (m === 'unsupported') {
      Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get: () => undefined });
      return;
    }
    const lock = {
      request: async () => {
        rec.requests++;
        if (m === 'refused') throw new DOMException('Not allowed', 'NotAllowedError');
        const listeners: (() => void)[] = [];
        const sentinel = {
          released: false,
          release: async () => {
            if (!sentinel.released) {
              sentinel.released = true;
              rec.releases++;
              listeners.forEach((f) => f());
            }
          },
          addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
        };
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') void sentinel.release();
        });
        return sentinel;
      },
    };
    Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get: () => lock });
  }, mode);
}

/** A fresh guest context (Welcome already seen) in the given browser. */
export async function guestPage(browser: Browser, opts: { wake?: WakeMode; mobile?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: BASE, locale: 'en-US', permissions: [] });
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem('sa.pref.welcomed', '1');
    } catch {
      /* ignore */
    }
  });
  if (opts.wake) await stubWakeLock(ctx, opts.wake);
  return ctx.newPage();
}

/**
 * Navigates to an app path and waits for the app shell. Playwright's Firefox driver sometimes never reports
 * the lifecycle events of a fresh page's first navigation although the document, assets and API calls all
 * completed (CI trace of run 42802588370: /receive 200 in 2 ms, app rendered, goto still waiting at 30 s).
 * So wait only for the commit, with a short bound, and then assert on the rendered app instead.
 */
export async function open(page: Page, path: string) {
  try {
    await page.goto(path, { waitUntil: 'commit', timeout: 10_000 });
  } catch (e) {
    if (!page.url().startsWith(new URL(path, BASE).origin)) throw e; // really did not navigate
  }
  await expect(page.locator('#main')).toBeVisible();
}

let senderBrowser: Browser | null = null;
/** The sender always runs in Chromium (docs/phases/PHASE_2_PAIRING_SIGNALING.md), whatever the project. */
export async function senderPage(wake: WakeMode = 'granted'): Promise<Page> {
  senderBrowser ??= await chromium.launch();
  return guestPage(senderBrowser, { wake });
}

export async function closeSenderBrowser() {
  await senderBrowser?.close();
  senderBrowser = null;
}

export interface Created {
  code: string;
  link: string;
  id: string;
}

/** Sender creates a session through the UI and returns its code, link and id. */
export async function createSession(page: Page, opts: { approval?: boolean } = {}): Promise<Created> {
  await open(page, '/send');
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'holiday.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048, 1) });
  if (opts.approval) await page.getByRole('switch', { name: 'Require approval' }).click();
  await page.getByRole('button', { name: /Create share session/ }).click();
  await page.waitForURL(/\/send\/session\//);
  const code = (await page.getByTestId('session-code').textContent())?.replace(/\D/g, '') ?? '';
  const link = (await page.getByTestId('session-link').textContent()) ?? '';
  const id = page.url().split('/').pop() ?? '';
  expect(code).toMatch(/^\d{6}$/);
  return { code, link, id };
}

/** Receiver enters a code on /receive and continues to the preview. */
export async function enterCode(page: Page, code: string) {
  await open(page, '/receive');
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Path part of a join link (same origin in the test stack). */
export function linkPath(link: string): string {
  return new URL(link).pathname;
}

/** A guest device created directly through the API (for filling a session to 5). */
export async function apiDevice(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE}/v1/devices/anonymous`, {
    data: { platform: 'API · Test', transport: 'body' },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).access_token as string;
}

export async function apiJoin(request: APIRequestContext, token: string, code: string): Promise<number> {
  const headers = { Authorization: `Bearer ${token}` };
  const r = await request.post(`${BASE}/v1/sessions/resolve-code`, { headers, data: { code } });
  if (!r.ok()) return r.status();
  const p = await r.json();
  const j = await request.post(`${BASE}/v1/sessions/${p.session_id}/join`, {
    headers,
    data: { ticket: p.join_ticket },
  });
  return j.status();
}

export async function advanceClock(request: APIRequestContext, seconds: number) {
  const r = await request.post(`${BASE}/v1/_test/clock`, { data: { advance_seconds: seconds } });
  expect(r.ok(), 'the CI stack must be built with -tags testhooks').toBeTruthy();
}

export async function setProtectedMode(request: APIRequestContext, active: boolean | null) {
  const r = await request.post(`${BASE}/v1/_test/protected-mode`, { data: { active } });
  expect(r.ok()).toBeTruthy();
}
