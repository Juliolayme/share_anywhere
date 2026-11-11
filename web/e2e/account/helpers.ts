import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { BASE, open } from '../pairing/helpers';

// Account specs (docs/TESTING_AND_CI.md §3): every test creates its own account, so specs never share state.

export const PASSWORD = 'Granite-Lantern-Orbit-7';

/** A fresh address per test (the backend lowercases and checks shape only). */
export function uniqueEmail(tag = 'acct'): string {
  return `e2e-${tag}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}@example.com`;
}

/**
 * Replaces a field's text with real keystrokes. Playwright's `fill` sets the value without key events under
 * WebDriver BiDi (the stock Firefox project), so React never sees it; typing behaves the same in every driver.
 */
export async function typeInto(field: Locator, text: string) {
  await field.click();
  await field.press('ControlOrMeta+a');
  await field.press('Backspace');
  await field.pressSequentially(text);
}

const screen = (page: Page, id: string) => page.locator(`[data-screen="${id}"]`);

async function fillCredentials(page: Page, email: string, password: string) {
  await typeInto(page.getByRole('textbox', { name: 'Email' }), email);
  await typeInto(page.getByLabel('Password', { exact: true }), password);
}

export interface Choices {
  /** "Add this device to your account" (default on). */
  add?: boolean;
  /** "Copy this device's transfer history" (default off; only when adding). */
  copy?: boolean;
}

/** On AC-4, sets the two switches and continues. */
export async function chooseAndContinue(page: Page, { add = true, copy = false }: Choices = {}) {
  await expect(screen(page, 'trust')).toBeVisible();
  const addSwitch = page.getByRole('switch', { name: 'Add this device to your account' });
  if ((await addSwitch.getAttribute('aria-checked')) !== String(add)) await addSwitch.click();
  if (add) {
    const copySwitch = page.getByRole('switch', { name: 'Copy this device’s transfer history to your account' });
    if ((await copySwitch.getAttribute('aria-checked')) !== String(copy)) await copySwitch.click();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** AC-5: reads the 12 words, confirms they were saved, and continues. Returns the phrase. */
export async function saveRecoveryPhrase(page: Page): Promise<string> {
  await expect(screen(page, 'key-setup')).toBeVisible();
  const words = page.getByTestId('recovery-word');
  await expect(words).toHaveCount(12, { timeout: 60_000 });
  const phrase = (await words.allTextContents()).map((w) => w.trim()).join(' ');
  expect(phrase.split(' ')).toHaveLength(12);
  await page.getByRole('checkbox', { name: 'I wrote down my recovery phrase' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  return phrase;
}

/** AC-8: the checklist is shown; Continue returns to where the flow started. */
export async function finishChecklist(page: Page) {
  await expect(screen(page, 'checklist')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Continue' }).click();
}

/**
 * Creates an account from `path` (an entry screen with a Create account link, or `/signup` directly). With the
 * device added on a new account, the key setup follows; returns the recovery phrase in that case.
 */
export async function signUp(
  page: Page,
  email: string,
  opts: Choices & { from?: string } = {},
): Promise<string | null> {
  await open(page, opts.from ?? '/signup');
  if (opts.from) await page.getByRole('link', { name: 'Create account' }).first().click();
  await expect(screen(page, 'signup')).toBeVisible();
  await fillCredentials(page, email, PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await chooseAndContinue(page, opts);
  const phrase = opts.add === false ? null : await saveRecoveryPhrase(page);
  await finishChecklist(page);
  return phrase;
}

/** Signs in on `/signin` (or from `from` with its Sign in link) and continues past AC-4. */
export async function signIn(page: Page, email: string, opts: Choices & { password?: string } = {}) {
  await open(page, '/signin');
  await expect(screen(page, 'signin')).toBeVisible();
  await fillCredentials(page, email, opts.password ?? PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await chooseAndContinue(page, opts);
}

/** Opens `path` and returns the device ID the app restored or created while loading. */
export async function deviceIdOnLoad(page: Page, path: string): Promise<string> {
  const res = page.waitForResponse(
    (r) => /\/v1\/devices\/(token|anonymous)$/.test(r.url()) && r.request().method() === 'POST' && r.ok(),
  );
  await open(page, path);
  return ((await (await res).json()) as { device: { id: string } }).device.id;
}

/** Writes a local History entry straight into this page's IndexedDB (as a finished transfer would). */
export async function addLocalEntry(
  page: Page,
  entry: { id: string; title: string; peer?: string; createdAt?: number; direction?: 'sent' | 'received' },
) {
  await page.evaluate(
    (e) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('share-anywhere', 1);
        req.onupgradeneeded = () =>
          req.result.createObjectStore('history', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('history', 'readwrite');
          tx.objectStore('history').put({
            id: e.id,
            direction: e.direction ?? 'sent',
            title: e.title,
            fileCount: 1,
            totalBytes: 4096,
            peer: e.peer ?? 'Test peer',
            status: 'completed',
            createdAt: e.createdAt ?? Date.now(),
            files: [{ name: e.title, size: 4096 }],
          });
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    entry,
  );
}

/** Polls the test mail sink (testhooks builds) for the newest reset link sent to `email`. */
export async function resetLink(request: APIRequestContext, email: string): Promise<string> {
  let link = '';
  await expect
    .poll(
      async () => {
        const r = await request.get(`${BASE}/v1/_test/mail/last?to=${encodeURIComponent(email)}`);
        if (!r.ok()) return '';
        link = ((await r.json()) as { link: string }).link;
        return link;
      },
      { timeout: 15_000 },
    )
    .toContain('/reset?token=');
  return link;
}

/** Turns on history sync from Settings (account-wide). */
export async function turnOnHistorySync(page: Page) {
  await open(page, '/settings');
  const sw = page.getByRole('switch', { name: 'Sync transfer history' });
  await expect(sw).toBeEnabled();
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
}

/** Opens History and waits until a sync pass finished ("Synced …"). */
export async function syncedHistory(page: Page) {
  await open(page, '/history');
  await expect(page.getByTestId('sync-status')).toContainText('Synced', { timeout: 30_000 });
}
