import { expect, test } from '@playwright/test';
import { closeContexts } from '../pairing/helpers';
import { uniqueEmail } from '../account/helpers';
import { clipboardCalls, clipboardPage, refocus, signUpFromClipboard, syncByPaste } from './helpers';

// The denied / gesture-required path (PRD §7.2): Firefox and Safari read the clipboard only through their own Paste
// UI after a click, mobile browsers ask first, and a refused permission stays refused. The page never reads on its
// own without a granted permission (no prompt loop), Sync Clipboard reads only in the click, and a refused read opens
// an actionable paste fallback. Capability detection is real; readText is made to refuse (see helpers.ts).
test.afterEach(closeContexts);
test.skip(
  ({ browserName, isMobile }) => browserName === 'chromium' && !isMobile,
  'chromium-desktop runs the granted path (granted.spec.ts); its denied capability states are covered by Vitest (runtime.test.ts)',
);

test('denied / gesture-required: manual only, no automatic reads, paste fallback syncs, Copy works or falls back', async ({
  browser,
  browserName,
  isMobile,
}) => {
  test.setTimeout(150_000);
  const page = await clipboardPage(browser, { denyRead: true });
  await signUpFromClipboard(page, uniqueEmail('cbdeny'));
  const status = page.getByTestId('cb-status');
  // Real capability detection: Firefox and WebKit expose no clipboard-read permission state (manual only); headless
  // mobile Chromium reports the permission as not decided or denied when the context was not granted it.
  const titles: Record<string, string> = {
    unsupported: 'This browser can’t read the clipboard automatically',
    besteffort: 'Automatic capture is best-effort',
    denied: 'Clipboard permission denied',
  };
  const allowed = browserName === 'chromium' ? ['besteffort', 'denied'] : ['unsupported'];
  await expect(status).toHaveAttribute('data-status', new RegExp(`^(${allowed.join('|')})$`));
  const state = (await status.getAttribute('data-status')) ?? '';
  await expect(page.getByTestId('cb-status-title')).toHaveText(titles[state] ?? '');
  if (state !== 'besteffort') await expect(status).toContainText('Click Sync Clipboard to read the current clipboard.');

  // Returning to the tab never reads the clipboard here: no prompt, no loop.
  for (let i = 0; i < 3; i++) await refocus(page);
  await page.waitForTimeout(1000);
  expect((await clipboardCalls(page)).readText).toBe(0);

  // Sync Clipboard reads once, inside the click; the refusal opens the paste fallback, which syncs the text.
  const text = `Pasted on ${isMobile ? 'a phone' : browserName} ${Date.now().toString(36)}`;
  await syncByPaste(page, text);
  expect((await clipboardCalls(page)).readText).toBe(1);
  for (let i = 0; i < 3; i++) await refocus(page);
  await page.waitForTimeout(1000);
  expect((await clipboardCalls(page)).readText).toBe(1);

  // Possibly sensitive text is skipped with the disclaimer, and "Sync anyway" sends it.
  await page.getByRole('button', { name: 'Sync Clipboard' }).click();
  const form = page.getByTestId('cb-paste');
  await form.getByRole('textbox', { name: 'Text to sync' }).pressSequentially('482913');
  await form.getByRole('button', { name: 'Sync this text' }).click();
  await expect(page.getByTestId('cb-sensitive')).toContainText('best-effort');
  await page.getByRole('button', { name: 'Sync anyway' }).click();
  await expect(page.getByTestId('cb-item-text').first()).toHaveText('482913');

  // Copy: writeText from the click, or the selection fallback; either way the user is told what happened.
  const row = page.getByTestId('cb-item').filter({ hasText: text });
  await row.getByRole('button', { name: /^Copy/ }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Copied to clipboard' })
      .or(page.getByTestId('cb-detail').getByRole('alert')),
  ).toBeVisible();
});
