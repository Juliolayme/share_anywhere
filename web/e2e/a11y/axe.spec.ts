import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  chooseAndContinue,
  finishChecklist,
  saveRecoveryPhrase,
  signIn,
  typeInto,
  uniqueEmail,
} from '../account/helpers';
import { clipboardPage, pairByCode, syncByPaste } from '../clipboard/helpers';
import {
  closeContexts,
  closeSenderBrowser,
  createSession,
  enterCode,
  guestPage,
  linkPath,
  open,
  senderPage,
} from '../pairing/helpers';
import {
  closeReceiverBrowsers,
  fixture,
  receiverPage,
  rxVerified,
  senderHook,
  startInBrowser,
} from '../transfer/helpers';

// Accessibility pass (docs/phases/PHASE_9_HARDENING_RELEASE.md): axe-core on every route and state, in every
// Playwright project; the guest routes in light and dark, the flows (transfer, receiver states, dialogs, account) in
// light. The run fails on serious or critical violations (WCAG 2.1 A/AA and best-practice
// rules); moderate and minor ones are attached to the report for triage.
test.afterAll(closeSenderBrowser);
test.afterEach(async () => {
  await closeReceiverBrowsers();
  await closeContexts();
});

async function audit(page: Page, label: string) {
  // Let entrance transitions finish so colour checks see the settled frame.
  await page.waitForTimeout(400);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  const blocking = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const minor = result.violations.filter((v) => !blocking.includes(v));
  if (minor.length > 0)
    await test.info().attach(`${label} (moderate/minor)`, {
      body: JSON.stringify(minor.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) }))),
      contentType: 'application/json',
    });
  // Soft: one run lists every screen's violations instead of stopping at the first.
  expect
    .soft(
      blocking.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      `${label}: serious/critical axe violations`,
    )
    .toEqual([]);
}

const guestRoutes: Array<[string, string]> = [
  ['/', 'home'],
  ['/send', 'send'],
  ['/receive', 'receive'],
  ['/history', 'history'],
  ['/devices', 'devices'],
  ['/settings', 'settings'],
  ['/clipboard', 'clipboard (guest)'],
  ['/signin', 'sign in'],
  ['/signup', 'create account'],
  ['/reset', 'reset password'],
  ['/no-such-page', 'not found'],
];

for (const scheme of ['light', 'dark'] as const) {
  test(`a11y: every guest route in ${scheme}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await guestPage(browser);
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path, label] of guestRoutes) {
      await open(page, path);
      await audit(page, `${label} (${scheme})`);
    }
    // Welcome is shown once, before the welcomed flag is set.
    await page.evaluate(() => window.localStorage.removeItem('sa.pref.welcomed'));
    await page.goto('/welcome');
    await expect(page.locator('[data-screen="welcome"]')).toBeVisible();
    await audit(page, `welcome (${scheme})`);
  });
}

test('a11y: a transfer end to end (session, preview, save, progress, result, dashboard)', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const f = fixture('8M');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  await audit(sender, 'session (waiting for receivers)');
  const rx = await receiverPage(browser, browserName);
  await open(rx, '/receive');
  await audit(rx, 'enter code');
  await enterCode(rx, s.code);
  await expect(rx.locator('[data-screen="receive-preview"]')).toBeVisible({ timeout: 30_000 });
  await audit(rx, 'join preview');
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.locator('[data-screen="receive-save"]')).toBeVisible();
  await audit(rx, 'where to save');
  await senderHook(sender, s.id, { pace: 250 });
  await startInBrowser(rx);
  await expect.poll(() => rxVerified(rx, s.id), { timeout: 30_000 }).toBeGreaterThan(0);
  await audit(rx, 'receiving');
  await audit(sender, 'session (receiving)');
  await senderHook(sender, s.id, { pace: 0 });
  await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  await audit(rx, 'receive result');
  await sender.goto(`/send/session/${s.id}/transfers`);
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
  await audit(sender, 'transfer dashboard (done)');
  await open(rx, '/history');
  await audit(rx, 'history with an entry');
  await rx.getByTestId('history-row').first().getByRole('link').click();
  await expect(rx.getByRole('dialog')).toBeVisible();
  await audit(rx, 'history detail');

  // A share link (/j/:token) lands on the join preview.
  const viaLink = await guestPage(browser);
  await open(viaLink, linkPath(s.link));
  await expect(viaLink.locator('[data-screen="receive-preview"]')).toBeVisible({ timeout: 30_000 });
  await audit(viaLink, 'join by link');
});

test('a11y: receiver states and the sender dialogs (approval, removed, blocked, ended)', async ({ browser }) => {
  test.setTimeout(180_000);
  const sender = await senderPage();
  const s = await createSession(sender, { approval: true });
  const rx = await guestPage(browser);
  await enterCode(rx, s.code);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.locator('[data-screen="receive-wait"]')).toBeVisible();
  await audit(rx, 'waiting for approval');
  await expect(sender.getByTestId('request-card')).toHaveCount(1);
  await audit(sender, 'session with a request');
  await sender.getByRole('button', { name: /^Approve / }).click();
  await expect(rx.getByTestId('joined-title')).toBeVisible();
  await audit(rx, 'joined, waiting for the sender');
  await audit(sender, 'session with a receiver');
  await sender.getByRole('button', { name: /^Remove / }).click();
  await expect(rx.getByTestId('receive-outcome')).toHaveAttribute('data-outcome', 'removed');
  await audit(rx, 'removed by the sender');

  // Rejoin, then Block after the confirmation dialog.
  await enterCode(rx, s.code);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(sender.getByTestId('request-card')).toHaveCount(1);
  await sender.getByRole('button', { name: /^Approve / }).click();
  await expect(rx.getByTestId('joined-title')).toBeVisible();
  await sender.getByRole('button', { name: /^Block / }).click();
  await expect(sender.getByRole('dialog')).toBeVisible();
  await audit(sender, 'block confirmation');
  await sender.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
  await expect(rx.getByTestId('receive-outcome')).toHaveAttribute('data-outcome', 'blocked');
  await audit(rx, 'blocked by the sender');

  // A second receiver sees the session end when the sender closes it.
  const s2 = await createSession(sender);
  const rx2 = await guestPage(browser);
  await enterCode(rx2, s2.code);
  await rx2.getByRole('button', { name: 'Receive' }).click();
  await expect(rx2.getByTestId('joined-title')).toBeVisible();
  await sender.getByRole('button', { name: 'Close session' }).first().click();
  const close = sender.getByRole('dialog');
  await expect(close).toBeVisible();
  await audit(sender, 'close session confirmation');
  await close.getByRole('button', { name: 'Close session' }).click();
  await expect(rx2.getByRole('heading', { name: 'The sender closed this session.' })).toBeVisible({ timeout: 30_000 });
  await audit(rx2, 'session ended');
});

test('a11y: account screens (create account, add device, key setup, checklist, pairing, signed-in tabs, drawers)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await clipboardPage(browser, { denyRead: true });
  const email = uniqueEmail('a11y');
  await open(page, '/signup');
  await audit(page, 'create account (form)');
  await typeInto(page.getByRole('textbox', { name: 'Email' }), email);
  await typeInto(page.getByLabel('Password', { exact: true }), PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('[data-screen="trust"]')).toBeVisible();
  await audit(page, 'add this device (choices)');
  await chooseAndContinue(page);
  await expect(page.getByTestId('recovery-word')).toHaveCount(12, { timeout: 60_000 });
  await audit(page, 'key setup (recovery phrase)');
  await saveRecoveryPhrase(page);
  await expect(page.locator('[data-screen="checklist"]')).toBeVisible({ timeout: 30_000 });
  await audit(page, 'checklist');
  await finishChecklist(page);
  for (const [path, label] of [
    ['/settings', 'settings (signed in)'],
    ['/devices', 'devices (signed in)'],
    ['/history', 'history (signed in)'],
    ['/clipboard', 'clipboard (signed in)'],
    ['/settings/clipboard', 'clipboard settings'],
  ] as const) {
    await open(page, path);
    await audit(page, label);
  }

  // Clipboard: the paste form, a synced item and its detail drawer.
  await open(page, '/clipboard');
  await page.getByRole('button', { name: 'Sync Clipboard' }).click();
  await expect(page.getByTestId('cb-paste')).toBeVisible();
  await audit(page, 'clipboard paste form');
  await page.keyboard.press('Escape');
  await syncByPaste(page, 'Meeting notes for Thursday');
  await page.getByTestId('cb-item').first().getByRole('link').click();
  await expect(page.getByTestId('cb-detail')).toBeVisible();
  await audit(page, 'clipboard item detail');

  // A second browser signs in to the same account: it pairs with the first (key pairing screen).
  const other = await clipboardPage(browser, { denyRead: true });
  await signIn(other, email);
  await expect(other.locator('[data-screen="key-pair"]')).toBeVisible({ timeout: 60_000 });
  await audit(other, 'pair this device');
  await pairByCode(page, other);
  await expect(other.locator('[data-screen="checklist"]')).toBeVisible({ timeout: 60_000 });
});
