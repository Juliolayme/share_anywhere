import { expect, test, type Page } from '@playwright/test';
import {
  apiDevice,
  apiJoinResult,
  closeSenderBrowser,
  createSession,
  enterCode,
  renameDevice,
  senderPage,
} from '../pairing/helpers';
import {
  attachDiagnostics,
  closeReceiverBrowsers,
  downloadAndHash,
  fixture,
  joinToSave,
  receiverHook,
  receiverPage,
  rxVerified,
  senderHook,
  startInBrowser,
  wl,
} from './helpers';

// Several receivers at once (docs/phases/PHASE_4_MULTI_RECEIVER_RESUME.md): a Chromium sender and two
// receivers in this project's browser. One receiver is slowed with a test-build hook that delays its block
// writes, which works in every engine (CDP network throttling only exists in Chromium).
test.afterAll(closeSenderBrowser);
const opened: Page[] = [];
test.afterEach(async () => {
  await attachDiagnostics(opened);
  opened.length = 0;
  await closeReceiverBrowsers();
});
test.skip(({ isMobile }) => isMobile, 'desktop projects (two receiver browsers per test)');

const track = (p: Page) => (opened.push(p), p);
const result = (rx: Page) => rx.getByTestId('receive-result');
const card = (sender: Page, name: string) =>
  sender.getByTestId('receiver-card').filter({ has: sender.getByText(name) });

async function receiver(browser: Parameters<typeof receiverPage>[0], browserName: string, name: string) {
  const rx = track(await receiverPage(browser, browserName));
  await renameDevice(rx, name);
  return rx;
}

test('two receivers, one slow: the fast one finishes first, the screen stays on until the last one ends', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const f = fixture('32M');
  const name = f.path.split('/').pop() ?? '';
  const sender = track(await senderPage('granted'));
  const s = await createSession(sender, { files: [f.path] });
  const fast = await receiver(browser, browserName, 'Receiver Fast');
  const slow = await receiver(browser, browserName, 'Receiver Slow');
  await joinToSave(fast, s.code);
  await joinToSave(slow, s.code);
  await receiverHook(slow, s.id, { pace: 1500 }); // 8 blocks × 1.5 s
  // End the join window so the sender holds the screen only for the transfers.
  await sender.getByRole('button', { name: 'Stop accepting' }).last().click();
  await expect(sender.getByTestId('code-expired')).toBeVisible();
  await startInBrowser(fast);
  await startInBrowser(slow);
  await sender.getByRole('button', { name: 'View transfers' }).click();

  await expect(result(fast)).toHaveAttribute('data-result', 'completed', { timeout: 90_000 });
  // The slow receiver did not hold the fast one back, and is still going.
  expect(await rxVerified(slow, s.id)).toBeLessThan(f.size);
  await expect(card(sender, 'Receiver Fast')).toHaveAttribute('data-status', 'completed');
  await expect(card(sender, 'Receiver Slow')).toHaveAttribute('data-status', 'transferring');
  // One transfer still runs: the sender keeps the screen on.
  await expect(sender.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'on');
  const held = await wl(sender);
  expect(held.requests).toBeGreaterThan(held.releases);

  await receiverHook(slow, s.id, { pace: 0 });
  await expect(result(slow)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
  await expect
    .poll(async () => {
      const w = await wl(sender);
      return w.releases >= w.requests;
    })
    .toBe(true);
  expect(await downloadAndHash(fast, name)).toBe(f.sha256);
  expect(await downloadAndHash(slow, name)).toBe(f.sha256);
});

test('Remove mid-transfer ends that receiver only; the other completes', async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  const f = fixture('32M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 400 });
  const keep = await receiver(browser, browserName, 'Receiver Keep');
  const gone = await receiver(browser, browserName, 'Receiver Gone');
  await joinToSave(keep, s.code);
  await joinToSave(gone, s.code);
  await startInBrowser(keep);
  await startInBrowser(gone);
  await sender.getByRole('button', { name: 'View transfers' }).click();
  await expect.poll(() => rxVerified(gone, s.id), { timeout: 60_000 }).toBeGreaterThan(0);

  await card(sender, 'Receiver Gone').getByRole('button', { name: 'Remove Receiver Gone' }).click();
  await expect(card(sender, 'Receiver Gone')).toHaveAttribute('data-status', 'removed', { timeout: 15_000 });
  await expect(gone.getByRole('heading', { name: 'The sender removed you from this session.' })).toBeVisible({
    timeout: 30_000,
  });

  await senderHook(sender, s.id, { pace: 0 });
  await expect(result(keep)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  await expect(card(sender, 'Receiver Keep')).toHaveAttribute('data-status', 'completed');
  // The removed receiver does not count against the result (docs/ARCHITECTURE.md §4.5).
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
});

test('Block mid-transfer ends that receiver, which cannot rejoin; the other completes', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const f = fixture('32M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 400 });
  const keep = await receiver(browser, browserName, 'Receiver Keep');
  const bad = await receiver(browser, browserName, 'Receiver Blocked');
  await joinToSave(keep, s.code);
  await joinToSave(bad, s.code);
  await startInBrowser(keep);
  await startInBrowser(bad);
  await sender.getByRole('button', { name: 'View transfers' }).click();
  await expect.poll(() => rxVerified(bad, s.id), { timeout: 60_000 }).toBeGreaterThan(0);

  await card(sender, 'Receiver Blocked').getByRole('button', { name: 'Block Receiver Blocked' }).click();
  await sender.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
  await expect(card(sender, 'Receiver Blocked')).toHaveAttribute('data-status', 'blocked', { timeout: 15_000 });
  await expect(bad.getByRole('heading', { name: 'The sender blocked this device from the session.' })).toBeVisible({
    timeout: 30_000,
  });

  // The code still works for others, but not for the blocked device.
  await enterCode(bad, s.code);
  await expect(bad.getByRole('alert')).toBeVisible();
  await expect(bad.locator('[data-screen="receive-save"]')).toHaveCount(0);

  await senderHook(sender, s.id, { pace: 0 });
  await expect(result(keep)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
});

test('Close session: every receiver sees the session end', async ({ browser, browserName }) => {
  test.setTimeout(150_000);
  const f = fixture('32M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 500 });
  const a = await receiver(browser, browserName, 'Receiver One');
  const b = await receiver(browser, browserName, 'Receiver Two');
  await joinToSave(a, s.code);
  await joinToSave(b, s.code);
  await startInBrowser(a);
  await startInBrowser(b);
  await sender.getByRole('button', { name: 'View transfers' }).click();
  await expect.poll(() => rxVerified(a, s.id), { timeout: 60_000 }).toBeGreaterThan(0);

  await sender.getByRole('button', { name: 'Close session' }).first().click();
  await sender.getByRole('dialog').getByRole('button', { name: 'Close session' }).click();
  for (const rx of [a, b])
    await expect(rx.getByRole('heading', { name: 'The sender closed this session.' })).toBeVisible({ timeout: 30_000 });
});

test('a receiver who joins after the result: the dashboard comes back, then New transfer closes the finished session', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(180_000);
  const f = fixture('8M');
  const sender = track(await senderPage('granted'));
  const s = await createSession(sender, { files: [f.path] });
  const first = await receiver(browser, browserName, 'Receiver First');
  await joinToSave(first, s.code);
  await startInBrowser(first);
  await sender.getByRole('button', { name: 'View transfers' }).click();
  await expect(result(first)).toHaveAttribute('data-result', 'completed', { timeout: 90_000 });
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
  // The join window is still open: the sender keeps the screen on, even on the result.
  await expect(sender.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'on');

  const late = await receiver(browser, browserName, 'Receiver Late');
  await joinToSave(late, s.code);
  await startInBrowser(late);
  // The provisional result clears while the late receiver transfers.
  await expect(sender.locator('[data-screen="dashboard"]')).toBeVisible({ timeout: 30_000 });
  await expect(sender.getByTestId('final-banner')).toHaveCount(0);
  await expect(result(late)).toHaveAttribute('data-result', 'completed', { timeout: 90_000 });
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
  await expect(card(sender, 'Receiver Late')).toHaveAttribute('data-status', 'completed');

  // New transfer closes the finished session (the window is open, so the sender confirms).
  await sender.getByRole('button', { name: 'New transfer' }).click();
  await sender.getByRole('dialog').getByRole('button', { name: 'Close session' }).click();
  await expect(sender).toHaveURL(/\/send$/);
  // The session is closed: its code no longer admits anyone.
  expect(await apiJoinResult(request, await apiDevice(request), s.code)).toEqual({
    status: 410,
    error: 'session_expired',
  });
  // Receivers that already have their files keep their result.
  for (const rx of [first, late]) await expect(result(rx)).toHaveAttribute('data-result', 'completed');
});
