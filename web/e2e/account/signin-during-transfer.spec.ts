import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE, apiDevice, closeSenderBrowser, createSession, senderPage } from '../pairing/helpers';
import {
  attachDiagnostics,
  closeReceiverBrowsers,
  fixture,
  joinToSave,
  receiverPage,
  rxVerified,
  senderHook,
  startInBrowser,
} from '../transfer/helpers';
import { PASSWORD, chooseAndContinue, finishChecklist, saveRecoveryPhrase, uniqueEmail, typeInto } from './helpers';

// PRD §2 "Signing in on a device": sign-in never interrupts an active transfer, because the device ID does not
// change. A guest receiver (this project's browser) finishes one transfer, then signs in from Settings while a
// second, paced transfer is running, and that transfer completes.
test.afterAll(closeSenderBrowser);
const opened: Page[] = [];
test.afterEach(async () => {
  await attachDiagnostics(opened);
  opened.length = 0;
  await closeReceiverBrowsers();
});

const track = (p: Page) => (opened.push(p), p);
const result = (rx: Page) => rx.getByTestId('receive-result');

/** An account made through the API from a throwaway guest device (the receiver itself stays a guest until it signs in). */
async function apiAccount(request: APIRequestContext): Promise<string> {
  const access_token = await apiDevice(request);
  const email = uniqueEmail('during');
  const res = await request.post(`${BASE}/v1/auth/signup`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: { email, password: PASSWORD, add_device: false, copy_history: false },
  });
  expect(res.status()).toBe(201);
  return email;
}

/** Clicks a visible navigation link (sidebar, rail, or bottom bar, whichever this viewport shows). */
async function nav(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name })
    .filter({ visible: true })
    .first()
    .click();
}

test('a guest finishes a transfer, then signs in from Settings during a second transfer, which completes', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(240_000);
  const email = await apiAccount(request);
  const sender = track(await senderPage('granted'));
  const rx = track(await receiverPage(browser, browserName));

  // 1. A whole transfer as a guest.
  const small = fixture('8M');
  const first = await createSession(sender, { files: [small.path] });
  await joinToSave(rx, first.code);
  await startInBrowser(rx);
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 90_000 });

  // 2. A second, paced transfer (8 blocks, 2.5 s each), with the device's ID taken from its first API call.
  const big = fixture('32M');
  const second = await createSession(sender, { files: [big.path] });
  await senderHook(sender, second.id, { pace: 2500 });
  const idRes = rx.waitForResponse((r) => /\/v1\/sessions\/resolve-code$/.test(r.url()) && r.ok());
  await joinToSave(rx, second.code);
  const tokenAtJoin = (await idRes).request().headers().authorization ?? '';
  const deviceAtJoin = JSON.parse(Buffer.from(tokenAtJoin.split('.')[1] ?? '', 'base64url').toString()).sub as string;
  await startInBrowser(rx);
  await expect(rx.locator('[data-screen="receive-progress"]')).toBeVisible();
  // 60 s like the multi-receiver specs: if a data channel fails to open, the receiver redials after its 20 s open
  // timeout (diagnostics record "dc open timeout"), so the first block can arrive after 30 s (CI 42989102231).
  await expect.poll(() => rxVerified(rx, second.id), { timeout: 60_000 }).toBeGreaterThan(0);

  // Sign in from Settings without leaving the app (no reload, so the transfer keeps running).
  await nav(rx, 'Settings');
  await rx.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).first().click();
  await expect(rx.locator('[data-screen="signin"]')).toBeVisible();
  await typeInto(rx.getByRole('textbox', { name: 'Email' }), email);
  await typeInto(rx.getByLabel('Password', { exact: true }), PASSWORD);
  const signin = rx.waitForResponse((r) => r.url().endsWith('/v1/auth/signin'));
  await rx.getByRole('button', { name: 'Sign in' }).click();
  const signedIn = (await (await signin).json()) as { device: { id: string } };
  expect(signedIn.device.id).toBe(deviceAtJoin);
  expect(await rxVerified(rx, second.id)).toBeLessThan(big.size);
  await chooseAndContinue(rx, { add: true });
  // The account was made without a key, so this first added device creates it.
  await saveRecoveryPhrase(rx);
  await finishChecklist(rx);
  await expect(rx).toHaveURL(/\/settings$/);
  await expect(rx.getByTestId('identity-label')).toHaveText(email);

  // The transfer that was running during sign-in finishes and verifies.
  await expect.poll(() => rxVerified(rx, second.id), { timeout: 120_000 }).toBe(big.size);
  await sender.getByRole('button', { name: 'View transfers' }).click();
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 60_000 });
  await nav(rx, 'History');
  await expect(rx.getByTestId('history-row')).toHaveCount(2);
});
