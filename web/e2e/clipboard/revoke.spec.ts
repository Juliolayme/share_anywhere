import { expect, test } from '@playwright/test';
import { closeContexts, open, renameDevice } from '../pairing/helpers';
import { finishChecklist, signIn, signUp, typeInto, uniqueEmail } from '../account/helpers';
import { cachedKeyVersions, clipboardPage, clipboardRecords, heldKeyVersions, syncByPaste } from './helpers';

// Revoking a device (DV-2) rotates the account key; new clipboard events use the new version, which the revoked
// device never receives, and it is a guest again with its keys and clipboard cache erased (PRD §7.5,
// docs/CLIPBOARD_PROTOCOL.md §2). Runs in every project.
test.afterEach(closeContexts);

test('revoke: the revoked device read items before, cannot decrypt new ones, and keeps nothing', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('cbrevoke');
  const a = await clipboardPage(browser, { denyRead: true });
  const phrase = (await signUp(a, email)) ?? '';
  const b = await clipboardPage(browser, { denyRead: true });
  await renameDevice(b, 'Old Phone');
  await signIn(b, email);
  await b.getByRole('button', { name: 'Use recovery phrase' }).click();
  await typeInto(b.getByRole('textbox', { name: 'Recovery phrase' }), phrase);
  await b.getByRole('button', { name: 'Unlock' }).click();
  await finishChecklist(b);

  // Before: A syncs, B decrypts it with key version 1.
  await open(a, '/clipboard');
  const before = `Before revoke ${Date.now().toString(36)}`;
  await syncByPaste(a, before);
  await open(b, '/clipboard');
  await expect(b.getByTestId('cb-item-text').first()).toHaveText(before, { timeout: 30_000 });
  expect(await heldKeyVersions(b)).toEqual([1]);

  // A revokes B: the key rotates to version 2 without B.
  await open(a, '/devices');
  await a.getByRole('button', { name: 'Revoke Old Phone' }).click();
  await a.getByRole('dialog', { name: 'Revoke Old Phone?' }).getByRole('button', { name: 'Revoke device' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Old Phone revoked · keys rotated' })).toBeVisible({
    timeout: 30_000,
  });

  // A's next item is encrypted under version 2.
  await open(a, '/clipboard');
  const after = `After revoke ${Date.now().toString(36)}`;
  await syncByPaste(a, after);
  await expect.poll(() => cachedKeyVersions(a), { timeout: 15_000 }).toEqual([1, 2]);

  // B: its account session is gone; it is a guest on the intro, holds no key and no clipboard data, and never shows
  // either item again.
  await open(b, '/clipboard');
  await expect(b.getByRole('heading', { name: 'Clipboard Sync' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => heldKeyVersions(b), { timeout: 15_000 }).toEqual([]);
  await expect.poll(() => clipboardRecords(b), { timeout: 15_000 }).toBe(0);
  await expect(b.getByText(after)).toHaveCount(0);
  await expect(b.getByText(before)).toHaveCount(0);
});
