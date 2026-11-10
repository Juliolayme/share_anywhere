import { expect, test } from '@playwright/test';
import {
  apiDevice,
  apiJoin,
  closeSenderBrowser,
  createSession,
  enterCode,
  guestPage,
  linkPath,
  senderPage,
} from './helpers';

// First vertical slice, all guests: sender on Chromium, receiver on this project's browser.
test.afterAll(closeSenderBrowser);

test('receive-preview: link in a fresh context joins immediately; both sides see the same security words', async ({
  browser,
}) => {
  const sender = await senderPage();
  const s = await createSession(sender);
  await expect(sender.getByTestId('countdown')).toHaveText(/^(10:00|9:5\d)$/);
  const rx = await guestPage(browser);
  await rx.goto(linkPath(s.link));
  await expect(rx.locator('[data-screen="receive-preview"]')).toBeVisible();
  await expect(rx.getByRole('heading', { level: 1 })).toContainText('wants to send you 1 file');
  await expect(rx.getByText('holiday.mp4')).toBeVisible();
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.getByTestId('joined-title')).toContainText('You joined');
  const rxWords = await rx.getByTestId('security-words').textContent();
  // Sender: join toast, card with Guest badge, same words.
  await expect(sender.getByRole('status').filter({ hasText: 'joined' }).first()).toBeVisible();
  const card = sender.getByTestId('participant-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Guest')).toBeVisible();
  await expect(card.getByTestId('security-words')).toHaveText(rxWords ?? '');
  await sender.context().close();
});

test('receive: six-digit code joins immediately', async ({ browser }) => {
  const sender = await senderPage();
  const s = await createSession(sender);
  const rx = await guestPage(browser);
  await enterCode(rx, s.code);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.getByTestId('joined-title')).toBeVisible();
  await expect(sender.getByTestId('participant-card')).toHaveCount(1);
  await sender.context().close();
});

test('receive-wait: approval on → receiver waits → approve; and reject', async ({ browser }) => {
  const sender = await senderPage();
  const s = await createSession(sender, { approval: true });
  const rx = await guestPage(browser);
  await enterCode(rx, s.code);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.locator('[data-screen="receive-wait"]')).toBeVisible();
  await expect(rx.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
  await expect(rx.getByTestId('keep-open-banner')).toBeVisible();
  await expect(sender.getByTestId('request-card')).toHaveCount(1);
  await sender.getByRole('button', { name: /^Approve / }).click();
  await expect(rx.getByTestId('joined-title')).toBeVisible();

  const rx2 = await guestPage(browser);
  await enterCode(rx2, s.code);
  await rx2.getByRole('button', { name: 'Receive' }).click();
  await expect(rx2.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
  await sender.getByRole('button', { name: /^Reject / }).click();
  await expect(rx2.getByTestId('receive-outcome')).toHaveAttribute('data-outcome', 'rejected');
  await sender.context().close();
});

test('session: Remove and Block; a blocked receiver cannot rejoin', async ({ browser }) => {
  const sender = await senderPage();
  const s = await createSession(sender);
  const rx = await guestPage(browser);
  await enterCode(rx, s.code);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.getByTestId('joined-title')).toBeVisible();
  await sender.getByRole('button', { name: /^Remove / }).click();
  await expect(rx.getByTestId('receive-outcome')).toHaveAttribute('data-outcome', 'removed');
  // Rejoin after a remove is allowed with a valid code; then Block.
  await enterCode(rx, s.code);
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.getByTestId('joined-title')).toBeVisible();
  await sender.getByRole('button', { name: /^Block / }).click();
  await sender.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
  await expect(rx.getByTestId('receive-outcome')).toHaveAttribute('data-outcome', 'blocked');
  await enterCode(rx, s.code);
  await expect(rx.getByRole('alert')).toHaveText('The sender blocked this device from the session.');
  await sender.context().close();
});

test('session: Stop accepting refuses the code and the link with the right message', async ({ browser }) => {
  const sender = await senderPage();
  const s = await createSession(sender);
  await sender.getByRole('button', { name: 'Stop accepting' }).click();
  await expect(sender.getByTestId('code-expired')).toContainText('Not accepting new receivers');
  const rx = await guestPage(browser);
  await enterCode(rx, s.code);
  await expect(rx.getByRole('alert')).toHaveText('The sender is no longer accepting receivers.');
  await rx.goto(linkPath(s.link));
  await expect(rx.getByRole('alert')).toContainText('Code expired — ask the sender for a new code');
  await sender.context().close();
});

test('session-full: the sixth receiver sees that the session is full', async ({ browser, request }) => {
  const sender = await senderPage();
  const s = await createSession(sender);
  for (let i = 0; i < 5; i++) expect(await apiJoin(request, await apiDevice(request), s.code)).toBe(200);
  await expect(sender.getByTestId('slots').first()).toHaveText('5/5 · Session full');
  await expect(sender.locator('[data-screen="session-full"]')).toHaveCount(1);
  const rx = await guestPage(browser);
  await enterCode(rx, s.code);
  await expect(rx.getByRole('alert')).toHaveText('This session is full.');
  await sender.context().close();
});

test('receive: an unknown code says so, and an expired link page explains', async ({ browser }) => {
  const rx = await guestPage(browser);
  await enterCode(rx, '000001');
  await expect(rx.getByRole('alert')).toHaveText(/Code not found|Code expired/);
  await rx.goto('/j/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await expect(rx.getByRole('alert')).toContainText('This link has expired');
});
