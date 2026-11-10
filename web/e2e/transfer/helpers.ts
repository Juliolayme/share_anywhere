import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, webkit, type Browser, type Download, type Page } from '@playwright/test';
import { BASE, enterCode, guestPage, stubWakeLock, type WakeMode } from '../pairing/helpers';

const DIR = process.env.E2E_FIXTURE_DIR ?? join(tmpdir(), 'sa-fixtures');
const SCRIPT = new URL('../../../scripts/gen-fixture.sh', import.meta.url).pathname;

export interface Fixture {
  path: string;
  sha256: string;
  size: number;
}

/** A sparse fixture from scripts/gen-fixture.sh (generated once per machine, never committed). */
export function fixture(size: string, name = `fixture-${size}.bin`): Fixture {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, name);
  const shaFile = `${path}.sha256`;
  if (!existsSync(path) || !existsSync(shaFile)) {
    const sha = execFileSync(SCRIPT, [size, path], { encoding: 'utf8' }).trim();
    writeFileSync(shaFile, sha);
  }
  const bytes = Number(execFileSync('stat', ['-c', '%s', path], { encoding: 'utf8' }).trim());
  return { path, sha256: readFileSync(shaFile, 'utf8').trim(), size: bytes };
}

export async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Receiver joins with the code and reaches the save-location screen. */
export async function joinToSave(rx: Page, code: string) {
  await enterCode(rx, code);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.locator('[data-screen="receive-save"]')).toBeVisible();
  await expect(rx.getByTestId('capability-row')).toBeVisible();
}

/** Chooses "Keep in this browser, then download" and starts. */
export async function startInBrowser(rx: Page) {
  await rx.getByTestId('save-opfs').click();
  await rx.getByRole('button', { name: 'Start receiving' }).click();
}

/** Downloads a finished file from RX-7 and returns its SHA-256. */
export async function downloadAndHash(rx: Page, name: string): Promise<string> {
  const wait: Promise<Download> = rx.waitForEvent('download');
  await rx.getByRole('button', { name: `Download ${name}` }).click();
  const dl = await wait;
  expect(dl.suggestedFilename()).toBe(name);
  const path = await dl.path();
  return sha256Of(path);
}

interface Counters {
  duplicates: number;
  blocksReceived: number;
  nacksSent: number;
  resumedBytes: number;
}

/** Engine counters exposed by test builds (VITE_TEST_HOOKS). */
export function receiverCounters(rx: Page, sessionId: string): Promise<Counters> {
  return rx.evaluate(
    (id) =>
      (window as unknown as { __saTest: { receivers: Record<string, { counters: Counters }> } }).__saTest.receivers[id]
        ?.counters ?? { duplicates: -1, blocksReceived: -1, nacksSent: -1, resumedBytes: -1 },
    sessionId,
  );
}

/**
 * The receiver in this project's browser. Playwright's WebKit contexts are ephemeral (Safari private
 * browsing, which has no Origin Private File System), so WebKit receivers run in a persistent context, like a
 * normal Safari window (docs/TESTING_AND_CI.md §3).
 */
export async function receiverPage(browser: Browser, browserName: string, wake?: WakeMode): Promise<Page> {
  if (browserName !== 'webkit') return guestPage(browser, wake ? { wake } : {});
  const use = test.info().project.use;
  const ctx = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'sa-webkit-')), {
    baseURL: BASE,
    locale: 'en-US',
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
    ...(use.isMobile !== undefined ? { isMobile: use.isMobile } : {}),
    ...(use.hasTouch !== undefined ? { hasTouch: use.hasTouch } : {}),
  });
  if (wake) await stubWakeLock(ctx, wake);
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem('sa.pref.welcomed', '1');
    } catch {
      /* ignore */
    }
  });
  return ctx.pages()[0] ?? ctx.newPage();
}

type Hooks = {
  __saTest: {
    senders: Record<string, { pace: { ms: number }; corrupt: { blocks: number }; dropFor(ms: number): void }>;
    receivers: Record<string, { state: { phase: string; verified: number } }>;
  };
};

/** Test-build hooks on the sender: pace blocks, corrupt the next blocks, or drop every peer for a while. */
export async function senderHook(
  sender: Page,
  sessionId: string,
  hook: { pace?: number; corrupt?: number; dropForMs?: number },
) {
  await expect
    .poll(() => sender.evaluate((id) => !!(window as unknown as Hooks).__saTest?.senders[id], sessionId))
    .toBe(true);
  await sender.evaluate(
    ([id, h]) => {
      const c = (window as unknown as Hooks).__saTest.senders[id as string];
      const hk = h as { pace?: number; corrupt?: number; dropForMs?: number };
      if (!c) return;
      if (hk.pace !== undefined) c.pace.ms = hk.pace;
      if (hk.corrupt !== undefined) c.corrupt.blocks = hk.corrupt;
      if (hk.dropForMs !== undefined) c.dropFor(hk.dropForMs);
    },
    [sessionId, hook] as const,
  );
}

export function rxVerified(rx: Page, sessionId: string): Promise<number> {
  return rx.evaluate((id) => (window as unknown as Hooks).__saTest?.receivers[id]?.state.verified ?? 0, sessionId);
}

export const wl = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wl: { requests: number; releases: number } }).__wl);

export const MiB = 1024 * 1024;
