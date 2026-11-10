import { expect, test } from '@playwright/test';
import { apiDevice, apiJoin, closeSenderBrowser, createSession, senderPage } from './helpers';

// Layout regressions on the sender's session screen (Chromium sender, so this runs once per project cheaply).
test.afterAll(closeSenderBrowser);

test('session: the code stays on one readable line from phone to wide desktop', async () => {
  const sender = await senderPage();
  await createSession(sender);
  const code = sender.getByTestId('session-code');
  for (const width of [360, 390, 760, 1099, 1280, 1440, 1920]) {
    await sender.setViewportSize({ width, height: 900 });
    const m = await code.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        font: parseFloat(cs.fontSize),
        line: parseFloat(cs.lineHeight),
        height: el.getBoundingClientRect().height,
      };
    });
    expect(m.line, `line-height at ${width}px`).toBeGreaterThanOrEqual(m.font);
    expect(m.height, `one line at ${width}px`).toBeLessThan(m.font * 1.5);
    const overflow = await sender.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `no horizontal scroll at ${width}px`).toBeLessThanOrEqual(0);
  }
  await sender.context().close();
});

test('session-approved: a join request card uses the design request style', async ({ request }) => {
  const sender = await senderPage();
  const s = await createSession(sender, { approval: true });
  expect(await apiJoin(request, await apiDevice(request), s.code)).toBeLessThan(300);
  const card = sender.getByTestId('request-card');
  await expect(card).toHaveCount(1);
  const style = await card.evaluate((el) => {
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.style.color = 'var(--sa-send-soft)';
    document.body.append(probe);
    const sendSoft = getComputedStyle(probe).color;
    probe.style.color = 'var(--sa-send)';
    const send = getComputedStyle(probe).color;
    probe.remove();
    return { bg: cs.backgroundColor, border: cs.borderTopColor, pad: cs.paddingTop, sendSoft, send };
  });
  expect(style.bg).toBe(style.sendSoft);
  expect(style.border).toBe(style.send);
  expect(style.pad).toBe('16px');
  await sender.context().close();
});
