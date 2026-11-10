import { expect, test } from '@playwright/test';
import { closeSenderBrowser, createSession, guestPage, open, type WakeMode } from '../pairing/helpers';

// Keep screen on with navigator.wakeLock stubbed (docs/TESTING_AND_CI.md §3). Runs in this project's browser.
test.afterAll(closeSenderBrowser);

const wl = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __wl: { requests: number; releases: number } }).__wl);

for (const [mode, state, label] of [
  ['granted', 'on', 'Screen stays on'],
  ['refused', 'refused', 'Couldn’t keep the screen on — keep this tab visible'],
  ['unsupported', 'unsupported', 'Your browser can’t keep the screen on — keep this tab visible'],
] as [WakeMode, string, string][]) {
  test(`session: screen-on pill in ${mode} mode`, async ({ browser }) => {
    const page = await guestPage(browser, { wake: mode });
    await createSession(page);
    const pill = page.getByTestId('screen-on-pill');
    await expect(pill).toHaveAttribute('data-state', state);
    await expect(pill).toHaveText(label);
    if (mode === 'granted') {
      expect((await wl(page)).requests).toBe(1);
      await page.getByRole('button', { name: 'Close session' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Close session' }).click();
      await expect(page.getByRole('heading', { name: 'Session closed' })).toBeVisible();
      await expect(page.locator('[data-screen="session-ended"]')).toHaveCount(1);
      await expect.poll(async () => (await wl(page)).releases).toBe(1);
    }
    await page.context().close();
  });
}

test('session: hidden → visible re-requests the lock; tapping the pill turns it off for this session', async ({
  browser,
}) => {
  const page = await guestPage(browser, { wake: 'granted' });
  await createSession(page);
  await expect(page.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'on');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await wl(page)).requests).toBe(2);
  await page.getByTestId('screen-on-pill').click();
  await expect(page.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'off');
  await page.context().close();
});

test('settings: with Keep screen on off, nothing is requested and the pill says so', async ({ browser }) => {
  const page = await guestPage(browser, { wake: 'granted' });
  await open(page, '/settings');
  await page.getByRole('switch', { name: 'Keep screen on during transfers' }).click();
  await createSession(page);
  await expect(page.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'setoff');
  expect((await wl(page)).requests).toBe(0);
  await page.context().close();
});
