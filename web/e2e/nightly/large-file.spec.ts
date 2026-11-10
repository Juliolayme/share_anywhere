import { expect, test, type Page } from '@playwright/test';
import { closeSenderBrowser, createSession, senderPage } from '../pairing/helpers';
import {
  MiB,
  downloadAndHash,
  fixture,
  joinToSave,
  receiverCounters,
  receiverPage,
  rxVerified,
  startInBrowser,
} from '../transfer/helpers';

// Nightly only (nightly.yml large-file, E2E_LARGE=1): 2 GB Web ↔ Web on chromium-desktop with a receiver
// reload mid-transfer, final SHA-256, and a JS heap ceiling on both sides (docs/TESTING_AND_CI.md §2.2).
test.skip(!process.env.E2E_LARGE, 'nightly large-file job only (E2E_LARGE=1)');
test.afterAll(closeSenderBrowser);

const CEILING = 512 * MiB; // the engine buffers at most a few 4 MiB blocks; whole-file buffering would blow this

async function heap(page: Page): Promise<number> {
  return page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );
}

test('large file: 2 GB arrives intact across a receiver reload, under the memory ceiling', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'chromium-desktop only (performance.memory)');
  test.setTimeout(30 * 60_000);
  const f = fixture(process.env.E2E_LARGE_SIZE ?? '2G');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  const rx = await receiverPage(browser, browserName, undefined, { persistent: true });
  await joinToSave(rx, s.code);
  await startInBrowser(rx);
  // Heap sampling runs in its own loops: an evaluate on a busy page waits for its main thread, and must not
  // delay the progress check that decides when to reload.
  const peak = { sender: 0, receiver: 0 };
  let sampling = true;
  const loop = async (key: 'sender' | 'receiver', page: () => Page) => {
    while (sampling) {
      const h = await heap(page()).catch(() => 0);
      peak[key] = Math.max(peak[key], h);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  let rxPage = rx;
  const loops = Promise.all([loop('sender', () => sender), loop('receiver', () => rxPage)]);
  const result = () =>
    rx
      .getByTestId('receive-result')
      .getAttribute('data-result', { timeout: 500 })
      .catch(() => null);
  // Let a quarter arrive, then reload the receiver mid-transfer.
  await expect
    .poll(
      async () => {
        if ((await result()) === 'failed') throw new Error('receive failed before the reload');
        return rxVerified(rx, s.id);
      },
      { timeout: 10 * 60_000, intervals: [250] },
    )
    .toBeGreaterThan(f.size / 4);
  const before = await rxVerified(rx, s.id);
  expect(before).toBeLessThan(f.size); // the reload really happens mid-transfer
  rxPage = rx;
  await rx.reload();
  await expect
    .poll(
      async () => {
        const r = await result();
        if (r === 'failed') throw new Error('receive failed after the reload');
        return r;
      },
      { timeout: 20 * 60_000, intervals: [2000] },
    )
    .toBe('completed');
  sampling = false;
  await loops;
  const c = await receiverCounters(rx, s.id);
  test.info().annotations.push({
    type: 'memory',
    description: `peak JS heap sender ${Math.round(peak.sender / MiB)} MiB, receiver ${Math.round(peak.receiver / MiB)} MiB; resumed from ${Math.round(c.resumedBytes / MiB)} MiB`,
  });
  expect(c.duplicates).toBe(0);
  expect(c.resumedBytes).toBeGreaterThan(0);
  expect(c.blocksReceived).toBe(Math.ceil(f.size / (4 * MiB)) - c.resumedBytes / (4 * MiB));
  expect(peak.sender).toBeLessThan(CEILING);
  expect(peak.receiver).toBeLessThan(CEILING);
  expect(await downloadAndHash(rx, f.path.split('/').pop() ?? '')).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});
