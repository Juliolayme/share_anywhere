import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeContexts, closeSenderBrowser, guestPage, open, senderPage } from '../pairing/helpers';
import { closeReceiverBrowsers, fixture, receiverPage } from '../transfer/helpers';

// Keyboard-only walkthrough (docs/phases/PHASE_9_HARDENING_RELEASE.md): a guest sends a file and another guest
// receives it with Tab, Shift+Tab, Enter, Space, arrows and typing only; every stop shows a visible focus
// indicator. Desktop projects with a Tab order that reaches links (Chromium, Firefox): phones have no keyboard,
// and WebKit skips links on Tab unless the system setting is on.
test.skip(({ isMobile, browserName }) => isMobile || browserName === 'webkit', 'desktop Chromium and Firefox');
test.afterAll(closeSenderBrowser);
test.afterEach(async () => {
  await closeReceiverBrowsers();
  await closeContexts();
});

/** The focused element (or the label it sits in, for the visually hidden file input) shows a focus ring. */
async function expectFocusVisible(page: Page, what: string) {
  const shown = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const ring = (n: Element) => {
      const cs = getComputedStyle(n);
      return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
    };
    return ring(el) || (el.closest('label') !== null && ring(el.closest('label') as Element));
  });
  expect(shown, `${what}: visible focus indicator`).toBe(true);
}

/** Presses Tab until `target` has focus (at most `max` stops). */
async function tabTo(page: Page, target: Locator, what: string, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      await expectFocusVisible(page, what);
      return;
    }
  }
  throw new Error(`${what}: not reached with Tab in ${max} stops`);
}

test('keyboard: skip link, send a file and receive it without a pointer', async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  const f = fixture('8M');

  // Sender (Chromium).
  const sender = await senderPage();
  await open(sender, '/');
  // The first Tab reaches "Skip to content", which moves focus to the main region.
  await sender.keyboard.press('Tab');
  const skip = sender.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expectFocusVisible(sender, 'skip link');
  await sender.keyboard.press('Enter');
  await expect(sender).toHaveURL(/#main$/);
  await tabTo(sender, sender.getByRole('link', { name: /^Send/ }).first(), 'Send');
  await sender.keyboard.press('Enter');
  await expect(sender).toHaveURL(/\/send$/);
  const chooser = sender.waitForEvent('filechooser');
  await tabTo(sender, sender.getByTestId('file-input'), 'choose files');
  await sender.keyboard.press('Space');
  await (await chooser).setFiles(f.path);
  await tabTo(sender, sender.getByRole('button', { name: /Create share session/ }), 'Create share session');
  await sender.keyboard.press('Enter');
  await sender.waitForURL(/\/send\/session\//);
  const code = ((await sender.getByTestId('session-code').textContent()) ?? '').replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);

  // Receiver (this project's browser).
  const rx = await receiverPage(browser, browserName);
  await open(rx, '/receive');
  await tabTo(rx, rx.getByRole('textbox', { name: 'Digit 1 of 6' }), 'code digit 1');
  await rx.keyboard.type(code);
  await tabTo(rx, rx.getByRole('button', { name: 'Continue' }), 'Continue');
  await rx.keyboard.press('Enter');
  await expect(rx.locator('[data-screen="receive-preview"]')).toBeVisible({ timeout: 30_000 });
  await tabTo(rx, rx.getByRole('button', { name: 'Receive' }), 'Receive');
  await rx.keyboard.press('Enter');
  await expect(rx.locator('[data-screen="receive-save"]')).toBeVisible();
  // The save options are a radio group: Tab enters it, arrows move the choice, Space confirms.
  const radios = rx.getByRole('radio');
  await tabTo(rx, radios.and(rx.locator('[tabindex="0"]')).first(), 'save location');
  for (let i = 0; i < 4 && (await rx.getByTestId('save-opfs').getAttribute('aria-checked')) !== 'true'; i++) {
    await rx.keyboard.press('ArrowDown');
  }
  await rx.keyboard.press('Space');
  await expect(rx.getByTestId('save-opfs')).toHaveAttribute('aria-checked', 'true');
  await tabTo(rx, rx.getByRole('button', { name: 'Start receiving' }), 'Start receiving');
  await rx.keyboard.press('Enter');
  await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
});

test('keyboard: Settings switches and the theme toggle work from the keyboard', async ({ browser }) => {
  const page = await guestPage(browser);
  await open(page, '/settings');
  const keepOn = page.getByRole('switch', { name: /Keep screen on/ });
  const before = await keepOn.getAttribute('aria-checked');
  await tabTo(page, keepOn, 'Keep screen on');
  await page.keyboard.press('Space');
  await expect(keepOn).not.toHaveAttribute('aria-checked', before ?? '');
  const theme = page.getByRole('button', { name: /Theme|Giao diện/ }).first();
  const pressed = await theme.getAttribute('aria-pressed');
  await theme.focus();
  await expectFocusVisible(page, 'theme toggle');
  await page.keyboard.press('Enter');
  await expect(theme).not.toHaveAttribute('aria-pressed', pressed ?? '');
});
