import {
  chromium,
  expect,
  test,
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

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Navigates to an app path, then proves the navigation happened (URL) and the app rendered (shell).
 *
 * Playwright's Firefox driver sometimes never reports any lifecycle event, not even the commit, for a fresh
 * page's first navigation, although the document, its assets and the API calls all complete (CI traces of
 * runs 42802588370 and 42805131808). So the commit wait is bounded at 10 s, and on that timeout the
 * navigation is issued once more, with an annotation on the test so it shows in the report. Nothing is
 * swallowed: if the second attempt fails, or the URL is not the target afterwards, the test fails.
 * A retried `/j/<token>` resolves the link twice, so an unknown or expired link counts two failed lookups
 * against the lockout and protected-mode counters (harmless at the test thresholds).
 */
export async function open(page: Page, path: string) {
  const attempt = () => page.goto(path, { waitUntil: 'commit', timeout: 10_000 });
  try {
    await attempt();
  } catch (e) {
    if (!(e instanceof Error) || !/Timeout/i.test(e.message)) throw e;
    test.info().annotations.push({ type: 'navigation-retry', description: `${path}: no commit event within 10 s` });
    await attempt();
  }
  // A join link resolves in place (error) or moves on to the preview (success).
  const target = path.startsWith('/j/')
    ? new RegExp(`(${escapeRe(path)}|/join/preview)$`)
    : new RegExp(`${escapeRe(path)}$`);
  await expect(page).toHaveURL(target);
  await expect(page.locator('#main')).toBeVisible();
}

let senderBrowser: Browser | null = null;
/** The sender always runs in Chromium (docs/phases/PHASE_2_PAIRING_SIGNALING.md), whatever the project. */
export async function senderPage(wake: WakeMode = 'granted'): Promise<Page> {
  // Explicit channel and path: the Firefox project's stock-Firefox options would otherwise apply here too.
  senderBrowser ??= await chromium.launch({
    channel: 'chromium',
    executablePath: chromium.executablePath(),
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
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
export async function createSession(page: Page, opts: { approval?: boolean; files?: string[] } = {}): Promise<Created> {
  await open(page, '/send');
  await page
    .getByTestId('file-input')
    .setInputFiles(opts.files ?? { name: 'holiday.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048, 1) });
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
  // Typed key by key like a person (focus moves to the next digit); works the same in every driver.
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).pressSequentially(code);
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
