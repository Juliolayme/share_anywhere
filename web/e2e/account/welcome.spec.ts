import { expect, test } from '@playwright/test';
import { closeContexts, open } from '../pairing/helpers';

// Guest-first with accounts on (CLAUDE.md §7): Welcome → Transfer home and every Transfer, Receive and History
// screen stay free of sign-in screens; the account screens are reached only from account CTAs.
test.afterEach(closeContexts);

test('Welcome → Transfer home has no sign-in screen; Send, Receive and History work as a guest', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-screen="welcome"]')).toBeVisible();
  await page.getByRole('button', { name: 'Start sharing' }).click();
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
  for (const path of ['/send', '/receive', '/history']) {
    await open(page, path);
    await expect(page.locator('[data-screen="signin"], [data-screen="signup"]')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  }
  await open(page, '/send');
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.getByRole('button', { name: /Create share session/ })).toBeEnabled();
});

test('the optional Welcome sign-in link opens Sign in, and Back to sharing lands on Transfer home', async ({
  page,
}) => {
  await page.goto('/welcome');
  await page.getByRole('link', { name: 'Already have an account? Sign in' }).click();
  await expect(page.locator('[data-screen="signin"]')).toBeVisible();
  await page.getByRole('link', { name: 'Back to sharing' }).click();
  // Welcome counts as seen: Transfer home, not Welcome again.
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
});

test('returnTo only accepts same-origin paths', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Start sharing' }).click();
  await page.goto('/signin?returnTo=https%3A%2F%2Fevil.example%2F');
  await page.getByRole('link', { name: 'Back to sharing' }).click();
  await expect(page).toHaveURL(/localhost:8080\/$/);
  await page.goto('/signin?returnTo=%2F%2Fevil.example');
  await page.getByRole('link', { name: 'Back to sharing' }).click();
  await expect(page).toHaveURL(/localhost:8080\/$/);
  await page.goto('/signin?returnTo=%2Fhistory');
  await page.getByRole('link', { name: 'Back to sharing' }).click();
  await expect(page).toHaveURL(/\/history$/);
});
