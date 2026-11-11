import { expect, test } from '@playwright/test';
import { closeContexts, guestPage, open } from '../pairing/helpers';
import { signUp, uniqueEmail } from './helpers';

// AC-2 → AC-4 → AC-5 → AC-8 and DV-1 for both after-sign-in choices (docs/UX_SCREEN_MAP.md §7, §9).
test.afterEach(closeContexts);

test('sign up from Devices with "Add this device" on: key setup, checklist, back to Devices with the account list', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await guestPage(browser);
  const email = uniqueEmail('add');
  await open(page, '/devices');
  await expect(page.getByRole('heading', { name: 'Sync your device list' })).toBeVisible();
  const phrase = await signUp(page, email, { from: '/devices' });
  expect(phrase?.split(' ')).toHaveLength(12);
  // returnTo brought the flow back to Devices, now the account list with this device marked.
  await expect(page).toHaveURL(/\/devices$/);
  const rows = page.getByTestId('account-device');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('This device');
  await expect(rows.first()).toContainText('Trusted');
  await expect(page.getByRole('button', { name: 'Pair a new device' })).toBeEnabled();
  // Settings shows the account and the key on this device.
  await open(page, '/settings');
  await expect(page.getByTestId('identity-label')).toHaveText(email);
  await expect(page.getByTestId('key-status')).toContainText('Encryption key on this device');
  // The key survives a reload (kept in IndexedDB, wrapped by the non-extractable device KEK).
  await page.reload();
  await expect(page.getByTestId('identity-label')).toHaveText(email);
  await expect(page.getByTestId('key-status')).toContainText('Encryption key on this device');
});

test('sign up with "Add this device" off: not added, Devices offers "Add this device to your account"', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await guestPage(browser);
  const email = uniqueEmail('noadd');
  await signUp(page, email, { add: false, from: '/settings' });
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('identity-label')).toHaveText(email);
  await expect(page.getByText('Add this device to use Clipboard Sync')).toBeVisible();
  await open(page, '/devices');
  await expect(page.getByText('Add this device to your account')).toBeVisible();
  const rows = page.getByTestId('account-device');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Not trusted');
  // Read-only: no rename, revoke or pairing for a device that is not added.
  await expect(page.getByRole('button', { name: /^Rename/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pair a new device' })).toHaveCount(0);

  // Adding it later goes through the same choices and the key setup of a new account.
  await page.getByTestId('devices-add-device').click();
  await expect(page.locator('[data-screen="trust"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('[data-screen="key-setup"]')).toBeVisible();
  await expect(page.getByTestId('recovery-word')).toHaveCount(12, { timeout: 60_000 });
});
