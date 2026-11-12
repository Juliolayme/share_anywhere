import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signUp, uniqueEmail } from '../account/helpers';
import {
  closeContexts,
  closeSenderBrowser,
  createSession,
  enterCode,
  guestPage,
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

// Accessibility pass (docs/phases/PHASE_9_HARDENING_RELEASE.md): axe-core on every route, in every Playwright
// project, in light and dark. The run fails on serious or critical violations (WCAG 2.1 A/AA and best-practice
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
});

test('a11y: signed-in screens (key setup, checklist, settings, devices, clipboard)', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await guestPage(browser);
  await open(page, '/signup');
  await audit(page, 'create account (form)');
  await signUp(page, uniqueEmail('a11y'));
  for (const [path, label] of [
    ['/settings', 'settings (signed in)'],
    ['/devices', 'devices (signed in)'],
    ['/clipboard', 'clipboard (signed in)'],
    ['/settings/clipboard', 'clipboard settings'],
  ] as const) {
    await open(page, path);
    await audit(page, label);
  }
});
