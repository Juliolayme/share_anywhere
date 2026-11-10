import { expect, test, type Page } from '@playwright/test';
import { closeSenderBrowser, createSession, enterCode, guestPage, senderPage } from '../pairing/helpers';
import { fixture, receiverPage } from '../transfer/helpers';

// Visual baselines per mobile project (docs/TESTING_AND_CI.md §3). Baselines are generated on the CI runner
// (nightly.yml mobile-snapshots) so fonts match; values that change every run are masked.
test.skip(({ isMobile }) => !isMobile, 'mobile projects only');
test.afterAll(closeSenderBrowser);
const shot = (page: Page, name: string, mask: string[]) =>
  expect(page).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.01,
    mask: mask.map((m) => page.locator(m)),
  });

test('mobile screens match their baselines: session, preview, save location, result', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const f = fixture('8M');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  const rx = await receiverPage(browser, browserName);
  await enterCode(rx, s.code);
  await expect(rx.locator('[data-screen="receive-preview"]')).toBeVisible();
  await shot(rx, 'receive-preview.png', [
    '[data-testid="identity-badge"]',
    '[data-testid="preview-sender"]',
    'h1',
    '[role="status"]',
  ]);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.getByTestId('capability-row')).toBeVisible();
  await shot(rx, 'receive-save.png', [
    '[data-testid="joined-title"]',
    '[data-testid="save-summary"]',
    '[data-testid="security-words"]',
    '[data-testid="capability-row"] dd',
  ]);
  await rx.getByTestId('save-opfs').click();
  await rx.getByRole('button', { name: 'Start receiving' }).click();
  await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 60_000 });
  await shot(rx, 'receive-done.png', ['main li span']);
  await sender.context().close();
  await rx.context().close();
});

test('mobile session screen matches its baseline (QR, code, link, countdown masked)', async ({ browser }) => {
  const sender = await guestPage(browser, { wake: 'granted' });
  await createSession(sender);
  await shot(sender, 'session.png', [
    'svg[role="img"]',
    '[data-testid="session-code"]',
    '[data-testid="session-link"]',
    '[data-testid="countdown"]',
  ]);
  await sender.context().close();
});
