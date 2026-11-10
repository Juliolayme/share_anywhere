import { expect, test } from '@playwright/test';
import {
  advanceClock,
  closeSenderBrowser,
  createSession,
  enterCode,
  guestPage,
  linkPath,
  senderPage,
  setProtectedMode,
} from './helpers';

// These specs move the test server's clock and toggle protected mode (test-only hooks, single worker).
test.afterAll(closeSenderBrowser);

test('session-expired: 10:00 window ends, old code refused, Create new code restarts at 10:00, joined receiver unaffected', async ({
  browser,
  request,
}) => {
  const sender = await senderPage('granted');
  const s = await createSession(sender);
  const early = await guestPage(browser);
  await enterCode(early, s.code);
  await early.getByRole('button', { name: 'Receive' }).click();
  await expect(early.getByTestId('joined-title')).toBeVisible();
  await expect(sender.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'on');
  const releasesBefore = await sender.evaluate(
    () => (window as unknown as { __wl: { releases: number } }).__wl.releases,
  );

  await advanceClock(request, 600);
  await sender.reload();
  await expect(sender.getByTestId('code-expired')).toContainText('Code expired — Create new code');
  await expect(sender.getByTestId('session-code')).toHaveCount(0);
  await expect(sender.getByRole('img', { name: 'QR code to join this session' })).toHaveCount(0);
  // Window ended with nobody transferring: the pill shows paused (and any lock was released).
  await expect(sender.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'paused');
  const releasesAfter = await sender.evaluate(
    () => (window as unknown as { __wl: { releases: number } }).__wl.releases,
  );
  expect(releasesAfter).toBeGreaterThanOrEqual(releasesBefore);

  const late = await guestPage(browser);
  await enterCode(late, s.code);
  await expect(late.getByRole('alert')).toHaveText(/Code expired — ask the sender for a new code|Code not found/);
  await late.goto(linkPath(s.link));
  await expect(late.getByRole('alert')).toContainText('Code expired — ask the sender for a new code');
  // The receiver who joined before expiry is still in.
  await early.reload();
  await expect(early.getByTestId('joined-title')).toBeVisible();

  await sender.getByRole('button', { name: 'Create new code' }).click();
  await expect(sender.getByTestId('countdown')).toHaveText(/^(10:00|9:5\d)$/);
  const fresh = (await sender.getByTestId('session-code').textContent())?.replace(/\D/g, '') ?? '';
  await enterCode(late, fresh);
  await late.getByRole('button', { name: 'Receive' }).click();
  await expect(late.getByTestId('joined-title')).toBeVisible();
  await sender.context().close();
});

test('receive-wait: protected mode makes a code join wait for approval, with the explanation', async ({
  browser,
  request,
}) => {
  await setProtectedMode(request, true);
  try {
    const sender = await senderPage();
    const s = await createSession(sender);
    await expect(sender.getByText('Extra check is on')).toBeVisible();
    const rx = await guestPage(browser);
    await enterCode(rx, s.code);
    await expect(rx.getByText('Extra check: the sender needs to let you in')).toBeVisible();
    await rx.getByRole('button', { name: 'Receive' }).click();
    await expect(rx.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
    await expect(rx.getByText('Extra check: the sender needs to let you in')).toBeVisible();
    await sender.getByRole('button', { name: /^Approve / }).click();
    await expect(rx.getByTestId('joined-title')).toBeVisible();
    await sender.context().close();
  } finally {
    await setProtectedMode(request, null);
  }
});
