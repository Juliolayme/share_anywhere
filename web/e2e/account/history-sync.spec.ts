import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { closeContexts, guestPage, open, renameDevice } from '../pairing/helpers';
import {
  addLocalEntry,
  finishChecklist,
  signIn,
  signUp,
  syncedHistory,
  turnOnHistorySync,
  uniqueEmail,
  typeInto,
} from './helpers';

// Cloud history sync (HI-1, PRD §2 "History", §7.5): entries are encrypted on the device with the history subkey,
// pulled with the seq cursor on the account's other devices, and deletions travel as tombstones.
test.afterEach(closeContexts);

/** A second browser of the account that unlocks the key with the recovery phrase. */
async function secondDevice(browser: Browser, email: string, phrase: string): Promise<Page> {
  const b = await guestPage(browser);
  await signIn(b, email);
  await b.getByRole('button', { name: 'Use recovery phrase' }).click();
  await typeInto(b.getByRole('textbox', { name: 'Recovery phrase' }), phrase);
  await b.getByRole('button', { name: 'Unlock' }).click();
  await finishChecklist(b);
  return b;
}

test('history sync on: an entry recorded in context A appears in context B; deleting it in B removes it in A', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('sync');
  const a = await guestPage(browser);
  await renameDevice(a, 'Sync Desk A');
  const phrase = (await signUp(a, email)) ?? '';
  // Sync starts off: History offers to turn it on.
  await open(a, '/history');
  await expect(a.getByRole('button', { name: 'Turn on history sync' })).toBeVisible();
  await turnOnHistorySync(a);
  // After a reload the stored key still encrypts (the entry below is uploaded with it). Wait for the restored
  // session before navigating on: leaving a page while its refresh is in flight can lose the rotated cookie.
  await a.reload();
  await expect(a.getByTestId('identity-label')).toHaveText(email);
  await expect(a.getByTestId('key-status')).toContainText('Encryption key on this device');

  const title = `synced-${randomUUID().slice(0, 8)}.pdf`;
  await addLocalEntry(a, { id: `tx:${randomUUID()}`, title, peer: 'Lan’s Phone' });
  await syncedHistory(a);
  await expect(a.getByText(title)).toBeVisible();

  const b = await secondDevice(browser, email, phrase);
  await syncedHistory(b);
  await expect(b.getByText(title)).toBeVisible();
  await expect(b.getByText('Synced across your devices')).toBeVisible();
  // The detail names the device the entry came from.
  await b.getByRole('link', { name: new RegExp(title) }).click();
  await expect(b.getByTestId('history-detail-origin')).toHaveText('Sync Desk A');
  await b.getByRole('button', { name: 'Delete from history' }).click();
  await expect(b.getByText(title)).toHaveCount(0);

  // A pulls the tombstone on its next pass.
  await expect
    .poll(
      async () => {
        await syncedHistory(a);
        return a.getByText(title).count();
      },
      { timeout: 60_000 },
    )
    .toBe(0);
});

test('local history import: "Copy this device’s transfer history" uploads guest history once', async ({ browser }) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('import');
  const a = await guestPage(browser);
  await open(a, '/history');
  const old = `guest-era-${randomUUID().slice(0, 8)}.zip`;
  await addLocalEntry(a, {
    id: `rx:${randomUUID()}`,
    title: old,
    direction: 'received',
    createdAt: Date.now() - 86_400_000,
  });
  const phrase = (await signUp(a, email, { copy: true })) ?? '';

  const b = await secondDevice(browser, email, phrase);
  await turnOnHistorySync(b);
  await syncedHistory(b);
  await expect(b.getByText(old)).toBeVisible();
});

test('without the import, guest history recorded before sign-in stays on this device', async ({ browser }) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('noimport');
  const a = await guestPage(browser);
  await open(a, '/history');
  const old = `private-${randomUUID().slice(0, 8)}.zip`;
  await addLocalEntry(a, { id: `rx:${randomUUID()}`, title: old, createdAt: Date.now() - 86_400_000 });
  const phrase = (await signUp(a, email)) ?? '';
  await turnOnHistorySync(a);
  await syncedHistory(a);
  await expect(a.getByText(old)).toBeVisible();
  const b = await secondDevice(browser, email, phrase);
  await syncedHistory(b);
  await expect(b.getByTestId('history-empty')).toBeVisible();
  await expect(b.getByText(old)).toHaveCount(0);
});
