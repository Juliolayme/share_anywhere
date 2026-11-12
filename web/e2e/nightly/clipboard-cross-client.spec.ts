import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PASSWORD, typeInto, uniqueEmail } from '../account/helpers';
import { clipboardPage, signUpFromClipboard, syncByPaste } from '../clipboard/helpers';
import { closeContexts } from '../pairing/helpers';

// Nightly only: encrypted Clipboard Sync between the Web app and a native app (docs/CLIPBOARD_PROTOCOL.md) — Android on
// the emulator (clipboard-cross-client, scripts/android-clipboard-interop.sh) or iOS on the simulator (ios-web-interop,
// scripts/ios-clipboard-interop.sh, which writes the same android-*.txt files). The Web creates the account and
// its key and syncs an item; Android signs in, adds itself and shows a pairing code (the script writes it to
// android-pairing.txt); the Web sends the key; Android decrypts the Web's item and syncs one of its own, which the Web
// decrypts (android-marker.txt).
const DIR = process.env.CLIP_INTEROP_DIR ?? '';
test.skip(!DIR, 'clipboard-cross-client job only (CLIP_INTEROP_DIR)');
test.afterEach(closeContexts);

async function waitForFile(name: string, timeoutMs: number): Promise<string> {
  const path = join(DIR, name);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path)) {
      const v = readFileSync(path, 'utf8').trim();
      if (v) return v;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} never arrived`);
}

test('web and android exchange encrypted clipboard items', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const web = await clipboardPage(browser, { denyRead: true });
  const email = uniqueEmail('clipx');
  await signUpFromClipboard(web, email);
  const webMarker = `from-web-${Date.now()}`;
  await syncByPaste(web, webMarker);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'clip-account.json'), JSON.stringify({ email, password: PASSWORD, webMarker }));

  // Android shows its pairing code: the Web (ready) sends its key.
  const code = await waitForFile('android-pairing.txt', 5 * 60_000);
  await web.goto('/devices');
  await web.getByRole('button', { name: 'Pair a new device' }).click();
  const dialog = web.getByRole('dialog', { name: 'Pair a new device' });
  await typeInto(dialog.getByRole('textbox', { name: 'Code from the new device' }), code);
  await dialog.getByRole('button', { name: 'Find device' }).click();
  await dialog.getByRole('button', { name: 'Send key' }).click();
  await expect(dialog).toHaveCount(0);

  // Android's item decrypts on the Web.
  const androidMarker = await waitForFile('android-marker.txt', 5 * 60_000);
  await web.goto('/clipboard');
  await expect(web.getByTestId('cb-item-text').filter({ hasText: androidMarker })).toBeVisible({ timeout: 60_000 });
});
