import { expect, test, type Page } from '@playwright/test';
import { BASE, closeContexts, open, trackContext } from '../pairing/helpers';

// Responsive and browser pass (docs/phases/PHASE_9_HARDENING_RELEASE.md): visual baselines of the main screens in
// every Playwright project (three desktop engines, two phone profiles), light and dark, English and Vietnamese.
// Baselines are generated on the CI runner (nightly `visual-snapshots`, fonts must match) and committed; nightly
// `visual` compares against them. Values that change every run (device names, times) are masked. Runs only with
// E2E_VISUAL=1.
test.skip(!process.env.E2E_VISUAL, 'visual pass: E2E_VISUAL=1');
test.afterEach(closeContexts);

const routes: Array<[string, string]> = [
  ['/', 'home'],
  ['/send', 'send'],
  ['/receive', 'receive'],
  ['/history', 'history'],
  ['/settings', 'settings'],
  ['/signin', 'signin'],
];

// Text that differs per run: the generated device name, server-dependent times, the identity chip.
const MASK = [
  '[data-testid="device-name"]',
  '[data-testid="identity-badge"]',
  '[data-testid="settings-device-name"]',
  'time',
  '[role="status"]',
];

// Per-run names replaced by a fixed text before each capture (masked as well).
const STABLE_TEXT = ['[data-testid="device-name"]', '[data-testid="settings-device-name"]'];

async function page(
  browser: import('@playwright/test').Browser,
  lang: 'en' | 'vi',
  scheme: 'light' | 'dark',
): Promise<Page> {
  const ctx = trackContext(
    await browser.newContext({ baseURL: BASE, locale: lang === 'vi' ? 'vi-VN' : 'en-US', colorScheme: scheme }),
  );
  await ctx.addInitScript((l: string) => {
    try {
      window.localStorage.setItem('sa.pref.welcomed', '1');
      window.localStorage.setItem('sa.pref.lang', l);
    } catch {
      /* ignore */
    }
  }, lang);
  return ctx.newPage();
}

for (const lang of ['en', 'vi'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`visual: main screens (${lang}, ${scheme})`, async ({ browser }) => {
      test.setTimeout(120_000);
      const p = await page(browser, lang, scheme);
      for (const [path, name] of routes) {
        await open(p, path);
        await p.waitForLoadState('networkidle').catch(() => undefined);
        // A mask hides the text but not its length: a long generated device name wraps on a phone and moves
        // everything below it. Give per-run names one fixed text first.
        await p.evaluate((selectors) => {
          for (const el of Array.from(document.querySelectorAll(selectors.join(',')))) {
            if (el.children.length === 0) el.textContent = 'Test device';
          }
        }, STABLE_TEXT);
        await expect(p).toHaveScreenshot(`${name}-${lang}-${scheme}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.01,
          mask: MASK.map((m) => p.locator(m)),
        });
      }
    });
  }
}
