import { expect, test } from '@playwright/test';
import { closeContexts, guestPage, open, renameDevice } from '../pairing/helpers';
import { finishChecklist, signIn, signUp, uniqueEmail, typeInto } from './helpers';

// AC-6: a second browser of the same account gets the Account Data Key by pairing (pasted code) or with the
// recovery phrase (docs/UX_SCREEN_MAP.md §9, PRD §7.5). Both contexts run in this project's browser.
test.afterEach(closeContexts);

test('a second context of the same account pairs with a pasted code and becomes ready', async ({ browser }) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('pair');
  const a = await guestPage(browser);
  await signUp(a, email);
  const b = await guestPage(browser);
  await signIn(b, email);
  // B is added but has no key: AC-6 shows the pairing QR and the code to paste.
  await expect(b.locator('[data-screen="key-pair"]')).toBeVisible();
  await expect(b.getByRole('img', { name: 'QR code to pair this device' })).toBeVisible();
  const code = (await b.getByTestId('pairing-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^sa1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);

  // A: Devices → Pair a new device → paste → confirm the waiting device → send the key.
  await open(a, '/devices');
  await expect(a.getByTestId('account-device')).toHaveCount(2);
  await a.getByRole('button', { name: 'Pair a new device' }).click();
  const dialog = a.getByRole('dialog', { name: 'Pair a new device' });
  await typeInto(dialog.getByRole('textbox', { name: 'Code from the new device' }), code);
  await dialog.getByRole('button', { name: 'Find device' }).click();
  await expect(dialog.getByTestId('pair-confirm')).toContainText('Send your encryption key to');
  await dialog.getByRole('button', { name: 'Send key' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(a.getByRole('status').filter({ hasText: 'Key sent to' })).toBeVisible();

  // B picks the key up and lands on the checklist with the key on this device.
  await expect(b.locator('[data-screen="checklist"]')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId('checklist')).toContainText('Encryption key on this device');
  await finishChecklist(b);
  await open(b, '/settings');
  await expect(b.getByTestId('key-status')).toContainText('Encryption key on this device');
  // A's list now shows both devices with keys (no "Not paired yet" chip).
  await open(a, '/devices');
  await expect(a.getByText('Not paired yet')).toHaveCount(0);
});

test('a pasted code that is not a pairing code, and a wrong recovery phrase, are refused with a reason', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('badpair');
  const a = await guestPage(browser);
  await signUp(a, email);
  await open(a, '/devices');
  await a.getByRole('button', { name: 'Pair a new device' }).click();
  const dialog = a.getByRole('dialog', { name: 'Pair a new device' });
  await typeInto(dialog.getByRole('textbox', { name: 'Code from the new device' }), 'hello world');
  await dialog.getByRole('button', { name: 'Find device' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/isn’t a pairing code/);
  await typeInto(
    dialog.getByRole('textbox', { name: 'Code from the new device' }),
    'sa1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
  );
  await dialog.getByRole('button', { name: 'Find device' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/No device is waiting with this code/);
  await a.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  const b = await guestPage(browser);
  await signIn(b, email);
  await b.getByRole('button', { name: 'Use recovery phrase' }).click();
  const box = b.getByRole('textbox', { name: 'Recovery phrase' });
  await typeInto(box, 'abandon abandon zzzz');
  await box.blur();
  await expect(b.getByText('“zzzz” isn’t a recovery word. Check the spelling.')).toBeVisible();
  // A valid BIP-39 phrase that is not this account's: Argon2id runs, then the unwrap fails.
  await typeInto(box, 'legal winner thank year wave sausage worth useful legal winner thank yellow');
  await b.getByRole('button', { name: 'Unlock' }).click();
  await expect(b.getByRole('alert')).toHaveText('This phrase doesn’t match your account’s key.', { timeout: 60_000 });
});

test('recovery phrase: a second context unlocks the key with the 12 words saved at sign-up', async ({ browser }) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('phrase');
  const a = await guestPage(browser);
  const phrase = (await signUp(a, email)) ?? '';
  const b = await guestPage(browser);
  await signIn(b, email);
  await expect(b.locator('[data-screen="key-pair"]')).toBeVisible();
  await b.getByRole('button', { name: 'Use recovery phrase' }).click();
  const box = b.getByRole('textbox', { name: 'Recovery phrase' });
  // Type one word partly and take the suggestion, like a person would (BIP-39 words are unique in four letters).
  const words = phrase.split(' ');
  const i = Math.max(
    0,
    words.findIndex((w) => w.length >= 5),
  );
  const word = words[i] ?? '';
  await box.pressSequentially(`${words.slice(0, i).join(' ')}${i ? ' ' : ''}${word.slice(0, 4)}`);
  await b.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: word, exact: true }).click();
  await box.pressSequentially(words.slice(i + 1).join(' '));
  await expect(b.getByText('12 of 12 words')).toBeVisible();
  await b.getByRole('button', { name: 'Unlock' }).click();
  await expect(b.locator('[data-screen="checklist"]')).toBeVisible({ timeout: 90_000 });
  await expect(b.getByTestId('checklist')).toContainText('Encryption key on this device');
});

test('revoke (DV-2): A revokes B, the key rotates, and B is a guest again with its keys erased', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('revoke');
  const a = await guestPage(browser);
  const phrase = (await signUp(a, email)) ?? '';
  const b = await guestPage(browser);
  await renameDevice(b, 'Revoked Laptop');
  await signIn(b, email);
  await b.getByRole('button', { name: 'Use recovery phrase' }).click();
  await typeInto(b.getByRole('textbox', { name: 'Recovery phrase' }), phrase);
  await b.getByRole('button', { name: 'Unlock' }).click();
  await finishChecklist(b);

  await open(a, '/devices');
  await expect(a.getByTestId('account-device')).toHaveCount(2);
  await a.getByRole('button', { name: 'Revoke Revoked Laptop' }).click();
  const dialog = a.getByRole('dialog', { name: 'Revoke Revoked Laptop?' });
  await expect(dialog).toContainText('Its file sharing keeps working as a guest.');
  await dialog.getByRole('button', { name: 'Revoke device' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Revoked Laptop revoked · keys rotated' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(a.getByTestId('account-device')).toHaveCount(1);

  // B's next request finds its account session gone: it continues as a guest and erases its keys.
  await open(b, '/settings');
  await expect(b.getByTestId('identity-label')).toHaveText('Guest', { timeout: 30_000 });
  await expect
    .poll(() =>
      b.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const r = indexedDB.open('share-anywhere-keys');
            r.onsuccess = () => {
              const c = r.result.transaction('adk', 'readonly').objectStore('adk').count();
              c.onsuccess = () => resolve(c.result);
            };
            r.onerror = () => resolve(-1);
          }),
      ),
    )
    .toBe(0);
  // A still holds a working key (the new version) after the rotation.
  await open(a, '/settings');
  await expect(a.getByTestId('key-status')).toContainText('Encryption key on this device');
});
