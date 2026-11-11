import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { closeContexts, guestPage, open } from '../pairing/helpers';
import { PASSWORD, addLocalEntry, deviceIdOnLoad, resetLink, signIn, signUp, uniqueEmail, typeInto } from './helpers';

// AC-7 sign-out (keep or clear local history, fresh anonymous identity) and AC-3 password reset through the
// test mail sink (docs/UX_SCREEN_MAP.md §9, PRD §2 "Signing out").
test.afterEach(closeContexts);

async function signOut(page: Page, choice: 'Keep local history' | 'Clear local history'): Promise<string> {
  await open(page, '/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign out of this browser?' });
  await dialog.getByRole('radio', { name: choice }).click();
  const res = page.waitForResponse((r) => r.url().endsWith('/v1/auth/signout') && r.ok());
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  const body = (await (await res).json()) as { device: { id: string } };
  await expect(page.getByRole('status').filter({ hasText: 'Signed out' })).toBeVisible();
  await expect(page.getByTestId('identity-label')).toHaveText('Guest');
  return body.device.id;
}

for (const choice of ['Keep local history', 'Clear local history'] as const) {
  test(`sign out (${choice.toLowerCase()}): a new device ID, keys erased, the app continues as a guest`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const page = await guestPage(browser);
    const before = await deviceIdOnLoad(page, '/history');
    const title = `kept-${randomUUID().slice(0, 8)}.mov`;
    await addLocalEntry(page, { id: `tx:${randomUUID()}`, title });
    await signUp(page, uniqueEmail('out'));
    const after = await signOut(page, choice);
    expect(after).not.toBe(before);

    // The new guest identity survives a reload (its cookie replaced the old one), with no reload loop.
    const reloaded = await deviceIdOnLoad(page, '/history');
    expect(reloaded).toBe(after);
    if (choice === 'Keep local history') await expect(page.getByText(title)).toBeVisible();
    else await expect(page.getByTestId('history-empty')).toBeVisible();
    await expect(page.getByTestId('history-signin')).toBeVisible();
    // The browser's key store is empty again.
    const keys = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const r = indexedDB.open('share-anywhere-keys');
          r.onsuccess = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('adk')) return resolve(0);
            const c = db.transaction('adk', 'readonly').objectStore('adk').count();
            c.onsuccess = () => resolve(c.result);
          };
          r.onerror = () => resolve(-1);
        }),
    );
    expect(keys).toBe(0);
  });
}

test('password reset: the emailed link sets a new password; the old one stops working', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('reset');
  const a = await guestPage(browser);
  await signUp(a, email, { add: false });

  const b = await guestPage(browser);
  await open(b, '/signin');
  await b.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(b.locator('[data-screen="forgot"]')).toBeVisible();
  await typeInto(b.getByRole('textbox', { name: 'Email' }), email);
  await b.getByRole('button', { name: 'Send reset link' }).click();
  await expect(b.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  const link = await resetLink(request, email);
  // The link opens like a click in a mail app (a fresh navigation); the token leaves the address bar once read.
  await b.goto(new URL(link).pathname + new URL(link).search);
  await expect(b).toHaveURL(/\/reset$/);
  const fresh = `${PASSWORD}-new`;
  await typeInto(b.getByLabel('New password', { exact: true }), fresh);
  await typeInto(b.getByLabel('Confirm new password', { exact: true }), fresh);
  await b.getByRole('button', { name: 'Save password' }).click();
  await expect(b.getByRole('heading', { name: 'Password changed' })).toBeVisible();

  // The reset ended A's account session: A is a guest again on its next request.
  await open(a, '/settings');
  await expect(a.getByTestId('identity-label')).toHaveText('Guest', { timeout: 30_000 });

  // The old password is refused, the new one works.
  await open(b, '/signin');
  await typeInto(b.getByRole('textbox', { name: 'Email' }), email);
  await typeInto(b.getByLabel('Password', { exact: true }), PASSWORD);
  await b.getByRole('button', { name: 'Sign in' }).click();
  await expect(b.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await signIn(b, email, { password: fresh, add: false });
  await expect(b.locator('[data-screen="checklist"]')).toBeVisible();
});
