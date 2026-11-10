import { expect, test } from '@playwright/test';
import { openAsReturningGuest } from '../fixtures';

test.skip(({ isMobile }) => !isMobile, 'mobile projects only');

test('home (mobile): compact bottom navigation with touch targets of at least 44 px', async ({ page }) => {
  await openAsReturningGuest(page);
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).filter({ visible: true });
  await expect(nav).toHaveCount(1);
  const links = nav.getByRole('link');
  await expect(links).toHaveText(['Transfer', 'History', 'Devices', 'Settings']);
  const navBox = await nav.boundingBox();
  const viewport = page.viewportSize();
  expect(navBox && viewport && navBox.y + navBox.height).toBeCloseTo(viewport?.height ?? 0, 0);
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  for (const name of ['Language', 'Theme']) {
    const box = await page.getByRole('button', { name }).first().boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  // No horizontal scroll at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('receive (mobile): code entry cells are touch-sized on phones', async ({ page }) => {
  await openAsReturningGuest(page, '/receive');
  for (let i = 1; i <= 6; i++) {
    const box = await page.getByRole('textbox', { name: `Digit ${i} of 6` }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
  }
});
