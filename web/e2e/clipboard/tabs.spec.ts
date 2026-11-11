import { expect, test, type Page } from '@playwright/test';
import { closeContexts, open } from '../pairing/helpers';
import { uniqueEmail } from '../account/helpers';
import { clipboardPage, goToClipboard, pairByCode, refocus, signInFromClipboard, signUpFromClipboard } from './helpers';

// Two tabs of one browser share the clipboard cache and the stored cursor, and each keeps its own timeline
// (docs/CLIPBOARD_PROTOCOL.md §2.9). A tab whose fetches could not run (a background tab the browser suspended) must
// not miss what the other tab pulled meanwhile: a new event, and the tombstone of a deleted one. QA 5B round 3.
test.afterEach(closeContexts);
test.skip(
  ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
  'Clipboard permissions can only be granted in desktop Chromium (Playwright grantPermissions); the shared-cursor logic is covered by Vitest (engine.test.ts, QA r3 T1–T6) in every engine',
);

const rows = (page: Page) => page.getByTestId('cb-item-text');
const setClipboard = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);

test('two tabs of one browser: a tab whose fetches were suspended catches up with what the other tab pulled', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail('cbtabs');
  const a1 = await clipboardPage(browser, { grant: true });
  await signUpFromClipboard(a1, email);
  await a1.getByRole('switch', { name: 'Automatic capture when permitted' }).click();
  // Second tab of the same browser profile (same IndexedDB, same device).
  const a2 = await a1.context().newPage();
  await open(a2, '/clipboard');
  await expect(a2.getByTestId('cb-status')).toBeVisible({ timeout: 30_000 });
  // Phone: a second device of the account, paired.
  const b = await clipboardPage(browser, { grant: true });
  await signInFromClipboard(b, email, { add: true });
  await pairByCode(a1, b);
  await goToClipboard(b);
  await b.getByRole('switch', { name: 'Automatic capture when permitted' }).click();
  await open(a1, '/clipboard');
  await expect(a1.getByTestId('cb-status')).toBeVisible({ timeout: 30_000 });
  const first = `first ${Date.now().toString(36)}`;
  await setClipboard(b, first);
  await b.getByRole('button', { name: 'Sync Clipboard' }).click();
  await expect(rows(a1).first()).toHaveText(first, { timeout: 20_000 });
  await expect(rows(a2).first()).toHaveText(first, { timeout: 20_000 });

  // Tab a2 goes to the background and is suspended. Headless Chromium does not freeze a page, so its own cursor
  // fetches fail instead, while tab a1 keeps pulling and moves the shared cursor.
  await a1.bringToFront();
  await a2.route('**/v1/clipboard/events?**', (r) => r.abort());
  const second = `second ${Date.now().toString(36)}`;
  await setClipboard(b, second);
  await b.getByRole('button', { name: 'Sync Clipboard' }).click();
  await expect(rows(a1).first()).toHaveText(second, { timeout: 20_000 });
  // The phone deletes the first item; tab a1 pulls the tombstone.
  await b.getByTestId('cb-item').filter({ hasText: first }).getByRole('link').click();
  await b.getByTestId('cb-detail').getByRole('button', { name: 'Delete' }).click();
  await expect(rows(a1).filter({ hasText: first })).toHaveCount(0, { timeout: 20_000 });
  await expect(rows(a1)).toHaveText([second]);

  // Back to tab a2: it resumes and catches up on focus. It shows the new event and no longer shows the deleted one.
  await a2.unroute('**/v1/clipboard/events?**');
  await a2.bringToFront();
  await refocus(a2);
  await expect(rows(a2)).toHaveText([second], { timeout: 20_000 });
  await expect(rows(a1)).toHaveText([second]);
});
