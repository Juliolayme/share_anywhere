import { expect, test, type Page } from '@playwright/test';
import { closeContexts, open } from '../pairing/helpers';
import { uniqueEmail } from '../account/helpers';
import {
  clipboardCalls,
  clipboardPage,
  goToClipboard,
  pairByCode,
  refocus,
  signInFromClipboard,
  signUpFromClipboard,
} from './helpers';

// CB-4 / CB-5 with clipboard permissions granted (docs/UX_SCREEN_MAP.md §10, PRD §7.1–§7.2). Only Chromium lets
// Playwright grant clipboard-read and clipboard-write to a context; the other projects run denied.spec.ts instead.
test.afterEach(closeContexts);
test.skip(
  ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
  'Clipboard permissions can only be granted in desktop Chromium (Playwright grantPermissions); the other projects cover the denied / gesture-required path in denied.spec.ts',
);

const setClipboard = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const rows = (page: Page) => page.getByTestId('cb-item-text');

test('granted: manual Sync reads the clipboard, a paired second context receives it live, Copy writes, auto-capture toggles', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('cbgrant');
  const a = await clipboardPage(browser, { grant: true });
  await signUpFromClipboard(a, email);
  // Permission granted and automatic capture on (default): automatic.
  await expect(a.getByTestId('cb-status')).toHaveAttribute('data-status', 'auto');
  await expect(a.getByTestId('cb-empty')).toBeVisible();

  // Automatic capture off: the status says capture is manual; then Sync reads the value the test put there.
  const auto = a.getByRole('switch', { name: 'Automatic capture when permitted' });
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await expect(a.getByTestId('cb-status')).toHaveAttribute('data-status', 'besteffort');
  await expect(a.getByTestId('cb-status-title')).toHaveText('Manual capture');
  const first = `Granted path ${Date.now().toString(36)} — meet at gate 12`;
  await setClipboard(a, first);
  const post = a.waitForRequest((r) => r.url().endsWith('/v1/clipboard/events') && r.method() === 'POST');
  await a.getByRole('button', { name: 'Sync Clipboard' }).click();
  const body = (await post).postDataJSON() as Record<string, unknown>;
  // Encrypted on the device: the request carries no plaintext.
  expect(JSON.stringify(body)).not.toContain('gate 12');
  expect(body.key_version).toBe(1);
  await expect(rows(a).first()).toHaveText(first);
  await expect(a.getByRole('status').filter({ hasText: 'Clipboard synced · encrypted' })).toBeVisible();

  // Second context of the same account: signs in from the Clipboard intro, gets the key by pasted pairing code, and
  // returns to Clipboard, where A's item is decrypted.
  const b = await clipboardPage(browser, { grant: true });
  await signInFromClipboard(b, email, { add: true });
  await pairByCode(a, b);
  await goToClipboard(b);
  await expect(rows(b).first()).toHaveText(first, { timeout: 30_000 });
  await b.getByRole('switch', { name: 'Automatic capture when permitted' }).click();

  // A syncs again; B shows it live (WebSocket notification → fetch by cursor), marked New, without a reload.
  await open(a, '/clipboard');
  const second = `Second item ${Date.now().toString(36)} for the phone`;
  await setClipboard(a, second);
  await a.getByRole('button', { name: 'Sync Clipboard' }).click();
  await expect(rows(a).first()).toHaveText(second);
  await expect(rows(b).first()).toHaveText(second, { timeout: 20_000 });
  const newest = b.getByTestId('cb-item').first();
  await expect(newest).toContainText('New');

  // Copy on B writes the item to the clipboard (overwriting something else first, so the check is meaningful).
  await setClipboard(b, 'something else entirely');
  await newest.getByRole('button', { name: /^Copy/ }).click();
  await expect(b.getByRole('status').filter({ hasText: 'Copied to clipboard' })).toBeVisible();
  expect(await readClipboard(b)).toBe(second);
  await expect(newest).not.toContainText('New');

  // Item detail (CB-5): full text, origin device, Copy and Delete.
  await newest.getByRole('link').click();
  const detail = b.getByTestId('cb-detail');
  await expect(detail.getByTestId('cb-detail-text')).toHaveText(second);
  await expect(b).toHaveURL(/\/clipboard\/[0-9a-f-]{36}$/);
  await b.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);

  // Automatic capture back on in A: returning to the tab (focus / visibility) reads the clipboard once, no click.
  await auto.click();
  await expect(a.getByTestId('cb-status')).toHaveAttribute('data-status', 'auto');
  const third = `Auto captured ${Date.now().toString(36)} on focus`;
  await setClipboard(a, third);
  await refocus(a);
  await expect(rows(a).first()).toHaveText(third, { timeout: 15_000 });
  await expect(rows(b).first()).toHaveText(third, { timeout: 20_000 });
  // And off again: focus no longer reads.
  await auto.click();
  const before = (await clipboardCalls(a)).readText;
  await setClipboard(a, 'not captured while off');
  await refocus(a);
  await a.waitForTimeout(1500);
  expect((await clipboardCalls(a)).readText).toBe(before);
  await expect(rows(a).filter({ hasText: 'not captured while off' })).toHaveCount(0);

  // Search and delete everywhere.
  await a.getByRole('searchbox', { name: 'Search clipboard' }).fill('gate 12');
  await expect(rows(a)).toHaveCount(1);
  await a.getByTestId('cb-item').first().getByRole('link').click();
  await a.getByTestId('cb-detail').getByRole('button', { name: 'Delete' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Item deleted on all devices' })).toBeVisible();
  await expect(rows(b).filter({ hasText: 'gate 12' })).toHaveCount(0, { timeout: 20_000 });
});
