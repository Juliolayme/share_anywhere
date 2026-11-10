import { expect, test, type Page } from '@playwright/test';
import { closeSenderBrowser, createSession, guestPage, senderPage } from '../pairing/helpers';
import {
  MiB,
  downloadAndHash,
  fixture,
  joinToSave,
  receiverCounters,
  attachDiagnostics,
  closeReceiverBrowsers,
  receiverPage,
  rxVerified,
  senderHook,
  sha256Of,
  startInBrowser,
  wl,
} from './helpers';

// Web ↔ Web transfers (docs/phases/PHASE_3_WEB_P2P_TRANSFER.md): Chromium sender, receiver in this project.
test.afterAll(closeSenderBrowser);
const opened: Page[] = [];
test.afterEach(async () => {
  await attachDiagnostics(opened);
  opened.length = 0;
  await closeReceiverBrowsers();
});
test.skip(({ isMobile }) => isMobile, 'mobile projects run e2e/mobile/transfer.spec.ts');

const track = (p: Page) => (opened.push(p), p);
const nameOf = (path: string) => path.split('/').pop() ?? '';
const result = (rx: Page) => rx.getByTestId('receive-result');

test('transfer: a 64 MB file arrives intact; History on both sides survives a reload', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const f = fixture('64M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  const rx = track(await receiverPage(browser, browserName));
  await joinToSave(rx, s.code);
  await startInBrowser(rx);
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 150_000 });
  await expect(rx.getByRole('heading', { name: 'All files received' })).toBeVisible();
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  expect((await receiverCounters(rx, s.id)).duplicates).toBe(0);
  await sender.goto(`/send/session/${s.id}/transfers`);
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
  await expect(sender.locator('[data-screen="dashboard-done"]')).toHaveCount(1);
  for (const page of [sender, rx]) {
    await page.goto('/history');
    await expect(page.getByText(nameOf(f.path))).toBeVisible();
    await page.reload();
    await expect(page.getByText(nameOf(f.path))).toBeVisible();
  }
  await sender.context().close();
  await rx.context().close();
});

test('transfer: pause and resume; the screen-on lock follows on both sides', async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  const f = fixture('64M');
  const sender = track(await senderPage('granted'));
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 250 });
  const rx = track(await receiverPage(browser, browserName, 'granted'));
  await joinToSave(rx, s.code);
  // End the join window so the sender holds the screen only for the transfer.
  await sender.getByRole('button', { name: 'Stop accepting' }).last().click();
  await expect(sender.getByTestId('code-expired')).toBeVisible();
  const senderBefore = await wl(sender);
  await startInBrowser(rx);
  await expect(rx.locator('[data-screen="receive-progress"]')).toBeVisible();
  await expect.poll(() => rxVerified(rx, s.id)).toBeGreaterThan(0);
  await expect(rx.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'on');
  expect((await wl(rx)).requests).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await wl(sender)).requests).toBeGreaterThan(senderBefore.requests);

  await rx.getByRole('button', { name: 'Pause' }).click();
  await expect(rx.getByTestId('transfer-status')).toHaveAttribute('data-state', 'paused');
  await expect.poll(async () => (await wl(rx)).releases).toBeGreaterThanOrEqual(1);
  await expect(rx.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'paused');
  // The sender (join window already ended) releases too while its only receiver is paused.
  await expect
    .poll(async () => {
      const w = await wl(sender);
      return w.releases >= w.requests;
    })
    .toBe(true);
  const atPause = await rxVerified(rx, s.id);
  await rx.waitForTimeout(1500);
  expect(await rxVerified(rx, s.id)).toBeLessThanOrEqual(atPause + 4 * 4 * MiB); // in-flight blocks only
  const beforeResume = await wl(rx);

  await rx.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(async () => (await wl(rx)).requests).toBeGreaterThan(beforeResume.requests);
  // Hidden → visible while active re-requests the lock.
  const beforeHide = await wl(rx);
  await rx.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await wl(rx)).requests).toBeGreaterThan(beforeHide.requests);
  await senderHook(sender, s.id, { pace: 0 });
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  // Released after completion on both sides.
  await expect.poll(async () => (await wl(rx)).releases).toBeGreaterThanOrEqual((await wl(rx)).requests);
  await expect
    .poll(async () => {
      const w = await wl(sender);
      return w.releases >= w.requests;
    })
    .toBe(true);
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});

test('transfer: cancel releases the lock and ends both sides', async ({ browser, browserName }) => {
  test.setTimeout(120_000);
  const f = fixture('64M');
  const sender = track(await senderPage('granted'));
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 300 });
  const rx = track(await receiverPage(browser, browserName, 'granted'));
  await joinToSave(rx, s.code);
  await sender.getByRole('button', { name: 'Stop accepting' }).last().click();
  await startInBrowser(rx);
  await expect.poll(() => rxVerified(rx, s.id)).toBeGreaterThan(0);
  await expect.poll(async () => (await wl(sender)).requests).toBeGreaterThan(0);
  await rx.getByRole('button', { name: 'Cancel' }).click();
  await rx.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(result(rx)).toHaveAttribute('data-result', 'cancelled');
  await expect
    .poll(async () => {
      const w = await wl(rx);
      return w.releases >= w.requests && w.requests > 0;
    })
    .toBe(true);
  // The sender releases after the cancel as well, and its dashboard shows the receiver cancelled.
  await expect
    .poll(async () => {
      const w = await wl(sender);
      return w.releases >= w.requests;
    })
    .toBe(true);
  await sender.getByRole('button', { name: 'View transfers' }).click();
  await expect(sender.getByTestId('receiver-card')).toHaveAttribute('data-status', 'cancelled', { timeout: 15_000 });
  await sender.context().close();
  await rx.context().close();
});

test('transfer: a receiver reload resumes from the saved bitmap with zero re-sent verified blocks', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const f = fixture('64M');
  const blocks = Math.ceil(f.size / (4 * MiB));
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 300 });
  const rx = track(await receiverPage(browser, browserName, 'granted'));
  await joinToSave(rx, s.code);
  await startInBrowser(rx);
  await expect.poll(() => rxVerified(rx, s.id), { timeout: 60_000 }).toBeGreaterThanOrEqual(4 * 4 * MiB);
  await rx.reload();
  await expect(rx.locator('[data-screen="receive-progress"], [data-screen="receive-done"]')).toHaveCount(1);
  // The reload must not leave the transfer PAUSED: bytes keep moving, nobody shows Paused, the screen stays on.
  await sender.getByRole('button', { name: 'View transfers' }).click();
  const card = sender.getByTestId('receiver-card');
  await expect(card).toHaveAttribute('data-status', 'transferring', { timeout: 30_000 });
  const resumedAt = await rxVerified(rx, s.id);
  await expect.poll(() => rxVerified(rx, s.id), { timeout: 30_000 }).toBeGreaterThan(resumedAt);
  await expect(rx.getByTestId('screen-on-pill')).toHaveAttribute('data-state', 'on');
  await expect(card).not.toHaveAttribute('data-status', 'paused');
  expect((await wl(rx)).releases).toBe(0);
  await senderHook(sender, s.id, { pace: 0 });
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  // Sender reaches TR-7 live, and after a reload (state rebuilt from the server records) still says completed.
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
  await sender.reload();
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 30_000 });
  await sender.goto('/history');
  await expect(sender.getByText(nameOf(f.path))).toBeVisible();
  const c = await receiverCounters(rx, s.id);
  expect(c.duplicates).toBe(0);
  expect(c.resumedBytes).toBeGreaterThanOrEqual(4 * 4 * MiB);
  expect(c.blocksReceived).toBe(blocks - c.resumedBytes / (4 * MiB));
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});

test('transfer: receiver pauses, reloads and resumes; the sender leaves Paused and holds the screen again', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const f = fixture('64M');
  const sender = track(await senderPage('granted'));
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 300 });
  const rx = track(await receiverPage(browser, browserName, 'granted'));
  await joinToSave(rx, s.code);
  await sender.getByRole('button', { name: 'Stop accepting' }).last().click();
  await startInBrowser(rx);
  await expect.poll(() => rxVerified(rx, s.id), { timeout: 60_000 }).toBeGreaterThan(4 * MiB);
  await rx.getByRole('button', { name: 'Pause' }).click();
  await sender.getByRole('button', { name: 'View transfers' }).click();
  const card = sender.getByTestId('receiver-card');
  await expect(card).toHaveAttribute('data-status', 'paused', { timeout: 15_000 });
  await expect.poll(async () => (await wl(sender)).releases).toBeGreaterThan(0);
  const requestsWhilePaused = (await wl(sender)).requests;
  await rx.reload();
  await expect(rx.getByTestId('transfer-status')).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  const at = await rxVerified(rx, s.id);
  await rx.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => rxVerified(rx, s.id), { timeout: 60_000 }).toBeGreaterThan(at + 4 * MiB);
  await expect(card).toHaveAttribute('data-status', 'transferring');
  await expect.poll(async () => (await wl(sender)).requests).toBeGreaterThan(requestsWhilePaused);
  await senderHook(sender, s.id, { pace: 0 });
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});

test('transfer: a corrupted block is NACKed and re-sent; the file still matches', async ({ browser, browserName }) => {
  test.setTimeout(120_000);
  const f = fixture('16M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { corrupt: 1 });
  const rx = track(await receiverPage(browser, browserName));
  await joinToSave(rx, s.code);
  await startInBrowser(rx);
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 60_000 });
  expect((await receiverCounters(rx, s.id)).nacksSent).toBe(1);
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});

test('transfer: when the sender drops off, the receiver shows reconnecting and resumes when it is back', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const f = fixture('64M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 250 });
  const rx = track(await receiverPage(browser, browserName));
  await joinToSave(rx, s.code);
  await startInBrowser(rx);
  await expect.poll(() => rxVerified(rx, s.id)).toBeGreaterThan(0);
  await senderHook(sender, s.id, { dropForMs: 4000 });
  await expect(rx.getByTestId('transfer-status')).toHaveAttribute('data-state', 'reconnecting', { timeout: 15_000 });
  await expect(rx.getByText('Connection lost — resuming automatically from the last verified block.')).toBeVisible();
  await senderHook(sender, s.id, { pace: 0 });
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  expect((await receiverCounters(rx, s.id)).duplicates).toBe(0);
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});

test('transfer: Save to a folder writes the verified file into the chosen folder (File System Access)', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'File System Access is Chromium-only');
  test.setTimeout(120_000);
  const f = fixture('8M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  const rx = track(await guestPage(browser));
  // The native picker cannot be driven; it returns a real directory handle (an OPFS folder).
  await rx.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
      async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
  });
  await joinToSave(rx, s.code);
  await rx.getByTestId('save-folder').click();
  await rx.getByRole('button', { name: 'Start receiving' }).click();
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 60_000 });
  await expect(rx.getByText('Saved in “picked-folder”')).toBeVisible();
  const got = await rx.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    const file = await (await dir.getFileHandle(name)).getFile();
    const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    return { size: file.size, sha: [...sum].map((b) => b.toString(16).padStart(2, '0')).join('') };
  }, nameOf(f.path));
  expect(got).toEqual({ size: f.size, sha: f.sha256 });
  expect(await sha256Of(f.path)).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});

test('transfer: in a private window (no browser storage) a small file is kept in memory', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'WebKit contexts are private windows without OPFS; others have storage');
  test.setTimeout(120_000);
  const f = fixture('8M');
  const sender = track(await senderPage());
  const s = await createSession(sender, { files: [f.path] });
  const rx = track(await guestPage(browser)); // ephemeral WebKit context = Safari private browsing
  await joinToSave(rx, s.code);
  await expect(rx.getByTestId('capability-row')).toHaveAttribute('data-opfs', 'false');
  await expect(
    rx.getByText('This browser can’t store files here, so only files up to 256 MB can be received.'),
  ).toBeVisible();
  await rx.getByTestId('save-memory').click();
  await rx.getByRole('button', { name: 'Start receiving' }).click();
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 60_000 });
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});
