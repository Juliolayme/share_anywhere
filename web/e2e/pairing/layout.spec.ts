import { expect, test } from '@playwright/test';
import { apiDevice, apiJoin, closeSenderBrowser, createSession, senderPage } from './helpers';

// Layout regressions on the sender's session screen (Chromium sender, so this runs once per project cheaply).
test.afterAll(closeSenderBrowser);

test('session: the code is readable and the copy button keeps its 44 px target at every width', async () => {
  const sender = await senderPage();
  await createSession(sender);
  const code = sender.getByTestId('session-code');
  for (const width of [320, 360, 390, 760, 1000, 1060, 1099, 1200, 1260, 1280, 1300, 1320, 1440, 1920]) {
    await sender.setViewportSize({ width, height: 900 });
    const m = await code.evaluate((el) => {
      const cs = getComputedStyle(el);
      const font = parseFloat(cs.fontSize);
      const line = parseFloat(cs.lineHeight);
      const button = el.parentElement?.querySelector('button')?.getBoundingClientRect();
      const row = el.parentElement?.getBoundingClientRect();
      const card = el.closest('section');
      const pad = card ? parseFloat(getComputedStyle(card).paddingRight) : 0;
      const cardRight = (card?.getBoundingClientRect().right ?? 0) - pad;
      // Right edge of the painted digits (not the span box, which can be narrower than its text).
      const range = document.createRange();
      range.selectNodeContents(el);
      const textRight = Math.max(...Array.from(range.getClientRects(), (r) => r.right));
      const qr = el.closest('section')?.querySelector('svg[role="img"]')?.getBoundingClientRect();
      const qrRow = el.closest('section')?.querySelector('svg[role="img"]')?.closest('div')?.getBoundingClientRect();
      return {
        textRight,
        buttonLeft: button?.left ?? 0,
        qrStacked: !!qr && !!button && qr.bottom <= el.getBoundingClientRect().top,
        qrOffset: qr && qrRow ? Math.abs(qr.left + qr.width / 2 - (qrRow.left + qrRow.width / 2)) : 0,
        font,
        line,
        lines: Math.round(el.getBoundingClientRect().height / line),
        height: el.getBoundingClientRect().height,
        bw: button?.width ?? 0,
        bh: button?.height ?? 0,
        rowRight: Math.max(row?.right ?? 0, button?.right ?? 0),
        cardRight,
      };
    });
    // The design lets the code break between its two groups of three when the column is narrow.
    expect(m.line, `line-height at ${width}px`).toBeGreaterThanOrEqual(m.font);
    expect(m.lines, `at most two lines at ${width}px`).toBeLessThanOrEqual(2);
    expect(Math.abs(m.height - m.lines * m.line), `lines do not overlap at ${width}px`).toBeLessThan(1);
    expect(m.bw, `copy button width at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(m.bh, `copy button height at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(m.rowRight, `code row inside the card at ${width}px`).toBeLessThanOrEqual(m.cardRight + 0.5);
    expect(m.textRight, `digits never under the copy button at ${width}px`).toBeLessThanOrEqual(m.buttonLeft + 0.5);
    if (m.qrStacked) expect(m.qrOffset, `QR centered when stacked at ${width}px`).toBeLessThanOrEqual(1);
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
  for (const name of [/^Approve /, /^Reject /]) {
    const box = await card.getByRole('button', { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await sender.context().close();
});
