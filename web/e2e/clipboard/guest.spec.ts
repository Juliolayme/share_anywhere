import { expect, test } from '@playwright/test';
import { closeContexts, guestPage, open } from '../pairing/helpers';
import { signUp, uniqueEmail } from '../account/helpers';
import { clipboardCalls, clipboardPage, goToClipboard, screen, signInFromClipboard } from './helpers';

// CB-1 (PRD §5.9): a guest who opens Clipboard sees the account-required intro, and the page makes no clipboard call
// of any kind (navigator.clipboard, permissions.query, copy/paste listeners), counted from before the app loads.
// Sign in from the intro comes back to Clipboard. Runs in every project.
test.afterEach(closeContexts);

const ZERO = { readText: 0, writeText: 0, read: 0, write: 0, query: 0, copyListeners: 0 };

test('guest: Clipboard shows the intro and makes zero clipboard calls; Sign in returns to Clipboard', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('cbguest');
  // The account exists already (created in another context, not this one).
  await signUp(await guestPage(browser), email);

  const page = await clipboardPage(browser);
  await open(page, '/clipboard');
  await expect(screen(page, 'clipboard')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clipboard Sync' })).toBeVisible();
  await expect(page.getByText('Your clipboard content is encrypted before sync — we can’t read it.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveAttribute(
    'href',
    '/signup?returnTo=%2Fclipboard',
  );
  await expect(page.getByRole('button', { name: 'Sync Clipboard' })).toHaveCount(0);
  // Navigate around as a guest and come back: still nothing.
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(screen(page, 'settings')).toBeVisible();
  await expect(page.getByText('Needs sign-in')).toBeVisible();
  await page.getByRole('link', { name: 'Clipboard', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Clipboard Sync' })).toBeVisible();
  expect(await clipboardCalls(page)).toEqual(ZERO);

  // Sign in from the intro without adding the device: the flow returns to Clipboard, which asks to add this device
  // (CB-2). Not ready yet, so still no clipboard call.
  await signInFromClipboard(page, email, { add: false });
  await goToClipboard(page);
  await expect(page.getByTestId('cb-add-device')).toContainText('Add this device to use Clipboard Sync');
  await expect(page.getByTestId('cb-add-device').getByRole('link', { name: 'Add this device' })).toHaveAttribute(
    'href',
    '/signin/choices?returnTo=%2Fclipboard',
  );
  expect(await clipboardCalls(page)).toEqual(ZERO);
});

test('guest: Clipboard settings (CB-6) are disabled with Sign in, and the tab is in the navigation', async ({
  browser,
}) => {
  const page = await clipboardPage(browser);
  await open(page, '/settings/clipboard');
  await expect(page.getByRole('heading', { name: 'Clipboard settings' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Pause Clipboard Sync' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Skip sensitive content' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: /^Keep items/ })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Sign in' }).last()).toHaveAttribute(
    'href',
    '/signin?returnTo=%2Fsettings%2Fclipboard',
  );
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).filter({ visible: true }).first();
  await expect(nav.getByRole('link', { name: 'Clipboard', exact: true })).toBeVisible();
  expect(await clipboardCalls(page)).toEqual(ZERO);
});
