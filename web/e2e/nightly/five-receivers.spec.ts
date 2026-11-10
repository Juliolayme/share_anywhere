import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium,
  expect,
  firefox,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { chromiumWebRtc, firefoxPrefs } from '../../playwright.config';
import {
  BASE,
  apiDevice,
  apiJoin,
  closeSenderBrowser,
  createSession,
  senderPage,
  stubWakeLock,
} from '../pairing/helpers';
import { downloadAndHash, fixture, joinToSave, receiverHook, rxVerified, startInBrowser } from '../transfer/helpers';

// Nightly only (nightly.yml five-receivers, E2E_FIVE=1; docs/TESTING_AND_CI.md §2.2): one guest sender and
// five guest receivers (three Chromium, one stock Firefox, one WebKit). One receiver is slowed with the
// test-build write delay (CDP network conditions do not throttle WebRTC data channels). Asserts that the
// other four finish first, that a sixth join is refused, and that the slow one then finishes too.
test.skip(!process.env.E2E_FIVE, 'nightly five-receivers job only (E2E_FIVE=1)');
test.skip(({ browserName }) => browserName !== 'chromium', 'runs once, from the chromium-desktop project');
test.afterAll(closeSenderBrowser);

const owned: (Browser | BrowserContext)[] = [];
test.afterAll(async () => {
  await Promise.all(owned.map((o) => o.close().catch(() => undefined)));
});

async function prepare(ctx: BrowserContext): Promise<Page> {
  await stubWakeLock(ctx, 'granted');
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem('sa.pref.welcomed', '1');
    } catch {
      /* ignore */
    }
  });
  return ctx.pages()[0] ?? ctx.newPage();
}

async function chromiumReceiver(): Promise<Page> {
  const b = await chromium.launch({
    channel: 'chromium',
    executablePath: chromium.executablePath(),
    ...chromiumWebRtc,
  });
  owned.push(b);
  return prepare(await b.newContext({ baseURL: BASE, locale: 'en-US' }));
}

async function firefoxReceiver(): Promise<Page> {
  const bin = process.env.E2E_FIREFOX_BIN;
  const b = await firefox.launch({
    ...(bin ? { channel: 'moz-firefox', executablePath: bin } : {}),
    firefoxUserPrefs: firefoxPrefs,
    args: [],
  });
  owned.push(b);
  const ctx = await b.newContext({ baseURL: BASE, locale: 'en-US', permissions: [] });
  // Same test-machine configuration as the PR suite (docs/TESTING_AND_CI.md §3).
  await ctx.grantPermissions(['camera', 'microphone'], { origin: BASE });
  return prepare(ctx);
}

async function webkitReceiver(): Promise<Page> {
  // Persistent: an ephemeral WebKit context has no Origin Private File System.
  // Explicit args: the chromium-desktop project's launch options would otherwise leak into this launch.
  const ctx = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'sa-five-webkit-')), {
    args: [],
    permissions: [],
    baseURL: BASE,
    locale: 'en-US',
  });
  owned.push(ctx);
  return prepare(ctx);
}

test('five receivers at once: the slow one does not hold back the others; a sixth join is refused', async ({
  request,
}) => {
  test.setTimeout(15 * 60_000);
  const f = fixture('64M');
  const name = f.path.split('/').pop() ?? '';
  const sender = await senderPage('granted');
  const s = await createSession(sender, { files: [f.path] });
  const receivers = [
    await chromiumReceiver(),
    await chromiumReceiver(),
    await chromiumReceiver(),
    await firefoxReceiver(),
    await webkitReceiver(),
  ];
  const slow = receivers[0] as Page;
  for (const rx of receivers) await joinToSave(rx, s.code);

  // The session is full: a sixth device is refused.
  const sixth = await apiJoin(request, await apiDevice(request), s.code);
  expect(sixth).toBeGreaterThanOrEqual(400);

  await receiverHook(slow, s.id, { pace: 2000 }); // 16 blocks × 2 s
  for (const rx of receivers) await startInBrowser(rx);
  await sender.getByRole('button', { name: 'View transfers' }).click();

  const others = receivers.slice(1);
  for (const rx of others)
    await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', {
      timeout: 10 * 60_000,
    });
  // All four finished while the slow one is still going.
  expect(await rxVerified(slow, s.id)).toBeLessThan(f.size);
  await expect(sender.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'on');

  await receiverHook(slow, s.id, { pace: 0 });
  await expect(slow.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 5 * 60_000 });
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 60_000 });
  for (const rx of receivers) expect(await downloadAndHash(rx, name)).toBe(f.sha256);
});
