import { expect, test } from '@playwright/test';
import { deviceIdFrom, openAsReturningGuest, sessionResponse } from '../fixtures';

// Guest-first smoke (docs/TESTING_AND_CI.md §3): no sign-in screen anywhere on the path. With the `accounts` flag
// on (Phase 5A) sign-in is only offered as an optional link; nothing asks for credentials.
test('welcome → home: first visit shows Welcome, Start sharing opens Transfer home, no sign-in screen anywhere', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { name: 'Big files, any device, any network.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /sign in|create account/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sign in|create account/i })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  // The only account affordance is the optional link (docs/UX_SCREEN_MAP.md ON-1).
  await expect(page.getByRole('link', { name: 'Already have an account? Sign in' })).toBeVisible();

  await expect(page.locator('[data-screen="welcome"]')).toBeVisible();
  await page.getByRole('button', { name: 'Start sharing' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-screen="home"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Transfer', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /Send files/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Receive files/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /sign in|create account/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Clipboard' })).toHaveCount(0);

  // Later visits skip Welcome.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Transfer', level: 1 })).toBeVisible();
});

test('home: reload keeps the same anonymous device ID', async ({ page }) => {
  const first = sessionResponse(page);
  await openAsReturningGuest(page);
  const id1 = await deviceIdFrom(first);
  const second = sessionResponse(page);
  await page.reload();
  const id2 = await deviceIdFrom(second);
  expect(id2).toBe(id1);
});

test('devices → settings: rename shows in Settings, and Settings says Guest', async ({ page }) => {
  await openAsReturningGuest(page, '/devices');
  await expect(page.getByTestId('device-name')).not.toHaveText(/Setting up/);
  await page.getByRole('button', { name: 'Rename' }).click();
  const input = page.getByRole('textbox', { name: 'Device name' });
  // Real keystrokes (select all, then type): behaves the same in every driver, including WebDriver BiDi.
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.pressSequentially('E2E Desk');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('device-name')).toHaveText('E2E Desk');
  await expect(page.getByRole('status').filter({ hasText: 'Device renamed' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('identity-label')).toHaveText('Guest');
  await expect(page.getByTestId('settings-device-name')).toHaveText('E2E Desk');
  // Guests are offered Sign in and Create account (links to the account screens), never asked to use them.
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).first()).toBeVisible();
  await expect(page.locator('#main').getByRole('link', { name: 'Create account' })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  // The name is stored on the server: it survives a reload.
  await page.reload();
  await expect(page.getByTestId('settings-device-name')).toHaveText('E2E Desk');
});

test('settings: theme and language switches persist across reloads and stay in sync with the header', async ({
  page,
}) => {
  await openAsReturningGuest(page, '/settings');
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Theme' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('radio', { name: 'Tiếng Việt' }).click();
  await expect(page.getByRole('heading', { name: 'Cài đặt', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('heading', { name: 'Cài đặt', level: 1 })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
});

test('devices: reset identity yields a new device ID', async ({ page }) => {
  const boot = sessionResponse(page);
  await openAsReturningGuest(page, '/devices');
  const before = await deviceIdFrom(boot);
  await page.getByRole('button', { name: 'Reset device identity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reset device identity' });
  await expect(dialog).toBeVisible();
  const reset = sessionResponse(page);
  await dialog.getByRole('button', { name: 'Reset device identity' }).click();
  const after = await deviceIdFrom(reset);
  expect(after).not.toBe(before);
  // The new identity is the one restored after reload.
  const reload = sessionResponse(page);
  await page.reload();
  expect(await deviceIdFrom(reload)).toBe(after);
});

test('home: a rate-limited bootstrap shows the wait time and a disabled retry', async ({ page }) => {
  await page.route('**/v1/devices/token', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'refresh_invalid', message: 'x' }),
    }),
  );
  await page.route('**/v1/devices/anonymous', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '120' },
      body: JSON.stringify({ error: 'rate_limited', message: 'Too many attempts.', retry_after_s: 120 }),
    }),
  );
  await openAsReturningGuest(page);
  await expect(page.getByRole('alert')).toContainText(/Too many attempts\. Try again in (2:00|1:5\d)\./);
  await expect(page.getByRole('button', { name: /Retry in/ })).toBeDisabled();
  // Navigation is never blocked by identity problems.
  await page.getByRole('link', { name: 'History' }).first().click();
  await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
});

test('receive: code entry validates the six digits on blur', async ({ page }) => {
  await openAsReturningGuest(page, '/receive');
  await expect(page.locator('[data-screen="receive"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).pressSequentially('4');
  await page.getByRole('textbox', { name: 'Or paste a share link' }).focus();
  await expect(page.getByRole('alert')).toHaveText('Enter all 6 digits.');
  await page.getByRole('textbox', { name: 'Digit 2 of 6' }).pressSequentially('82913');
  await expect(page.getByRole('textbox', { name: 'Digit 6 of 6' })).toHaveValue('3');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('history: starts empty and says it is stored only on this device', async ({ page }) => {
  await openAsReturningGuest(page, '/history');
  await expect(page.getByText('Stored only on this device · Guest')).toBeVisible();
  await expect(page.getByText('No transfers yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear history' })).toBeDisabled();
});

test('home: pages load with no Content-Security-Policy violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Content-Security-Policy|violates/i.test(msg.text())) violations.push(msg.text());
  });
  await openAsReturningGuest(page);
  for (const path of ['/', '/send', '/receive', '/history', '/devices', '/settings']) {
    await page.goto(path);
    await expect(page.locator('[data-screen]')).not.toHaveCount(0);
  }
  // Vietnamese text in the mono font uses its own subset file; it must load from 'self'.
  await page.getByRole('radio', { name: 'Tiếng Việt' }).click();
  await page.goto('/receive');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(violations).toEqual([]);
});

test('send-review: picking a file switches the screen ID', async ({ page }) => {
  await openAsReturningGuest(page, '/send');
  await expect(page.locator('[data-screen="send"]')).toHaveCount(1);
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('[data-screen="send-review"]')).toHaveCount(1);
  await expect(page.getByText('notes.txt')).toBeVisible();
});
