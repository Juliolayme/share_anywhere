import { expect, test } from '@playwright/test';
import { closeSenderBrowser, createSession, guestPage, enterCode, senderPage } from '../pairing/helpers';

test.skip(({ isMobile }) => !isMobile, 'mobile projects only');
test.afterAll(closeSenderBrowser);

test('session (mobile): QR and code are legible at phone size; receiver flow fits the screen', async ({ browser }) => {
  const sender = await guestPage(browser, { wake: 'granted' });
  const s = await createSession(sender);
  const qr = await sender.getByRole('img', { name: 'QR code to join this session' }).boundingBox();
  expect(qr?.width ?? 0).toBeGreaterThanOrEqual(160);
  const fontSize = await sender.getByTestId('session-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(28);
  const overflow = await sender.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const rx = await senderPage();
  await enterCode(rx, s.code);
  await expect(rx.getByRole('button', { name: 'Receive' })).toBeVisible();
  await sender.context().close();
  await rx.context().close();
});
