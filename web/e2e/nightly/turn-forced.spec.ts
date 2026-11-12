import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { chromiumWebRtc } from '../../playwright.config';
import { closeContexts, closeSenderBrowser, createSession, guestPage, senderPage } from '../pairing/helpers';
import {
  MiB,
  attachDiagnostics,
  downloadAndHash,
  fixture,
  joinToSave,
  receiverCounters,
  receiverPage,
  rxVerified,
  startInBrowser,
} from '../transfer/helpers';

// Nightly turn-forced (docs/TESTING_AND_CI.md §2.2, docs/phases/PHASE_8_ROUTE_TURN_CLOUD.md): relay-only transfers
// through the CI coturn (infra/coturn/turnserver.ci.conf) over UDP and over TLS, the badge says "Using relay", and a
// direct path that stops mid-transfer migrates to the relay and resumes from the bitmap. Test builds only
// (VITE_TEST_HOOKS): window.__SA_TEST_ICE_POLICY and __SA_TEST_ROUTE_STEP, and the receiver's testBlockDirect().
test.skip(!process.env.E2E_TURN, 'nightly turn-forced job only (E2E_TURN=1)');
let pages: Page[] = [];
let tlsBrowser: Browser | null = null;
test.afterEach(async () => {
  await attachDiagnostics(pages);
  pages = [];
});
test.afterAll(async () => {
  await tlsBrowser?.close();
});
test.afterAll(closeSenderBrowser);
test.afterEach(closeContexts);

async function forceRelay(page: Page, step?: 'relay-udp' | 'relay-tls') {
  await page.addInitScript((s) => {
    const w = window as unknown as { __SA_TEST_ICE_POLICY?: string; __SA_TEST_ROUTE_STEP?: string };
    w.__SA_TEST_ICE_POLICY = 'relay';
    if (s) w.__SA_TEST_ROUTE_STEP = s;
  }, step);
}

/** The sender's view of its (only) receiver's route kind. */
function senderRouteKind(sender: Page, sessionId: string): Promise<string | null> {
  return sender.evaluate((id) => {
    const w = window as unknown as {
      __saTest: { senders: Record<string, { state: { receivers: { routeKind: string | null }[] } }> };
    };
    return w.__saTest.senders[id]?.state.receivers[0]?.routeKind ?? null;
  }, sessionId);
}

/** Test hook: delay before each block is written on the receiver. */
async function pace(rx: Page, sessionId: string, ms: number) {
  await rx.evaluate(
    ([id, v]) => {
      const w = window as unknown as { __saTest: { receivers: Record<string, { pace: { ms: number } }> } };
      const r = w.__saTest.receivers[id as string];
      if (r) r.pace.ms = v as number;
    },
    [sessionId, ms],
  );
}

for (const step of ['relay-udp', 'relay-tls'] as const) {
  test(`forced relay over ${step === 'relay-udp' ? 'UDP' : 'TLS'}: the transfer completes on the relay`, async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'chromium-desktop (relayProtocol in getStats)');
    test.setTimeout(5 * 60_000);
    const name = `relay-${step}.bin`;
    const f = fixture('24M', name);
    const sender = await senderPage();
    await forceRelay(sender);
    const s = await createSession(sender, { files: [f.path] });
    // TURN over TLS to the CI coturn presents a self-signed certificate (scripts/turn-test-cert.sh); this receiver's
    // browser accepts it, a test-machine setting like the mDNS flag (production uses a real certificate, ADR 0029).
    tlsBrowser ??=
      step === 'relay-tls'
        ? await chromium.launch({ args: [...chromiumWebRtc.args, '--ignore-certificate-errors'] })
        : null;
    const rx =
      step === 'relay-tls' && tlsBrowser ? await guestPage(tlsBrowser) : await receiverPage(browser, browserName);
    pages = [sender, rx];
    await forceRelay(rx, step);
    await joinToSave(rx, s.code);
    // Slow the receiver while the badges are checked: on loopback the file would arrive first.
    await pace(rx, s.id, 40);
    await startInBrowser(rx);
    const chip = rx.getByTestId('route-chip');
    await expect(chip).toHaveAttribute('data-route', 'relay', { timeout: 60_000 });
    await expect(chip).toHaveAttribute('data-route-kind', step);
    await expect(chip).toContainText('Using relay');
    // The sender sees the same route for this receiver (its card and the dashboard read this state).
    await expect.poll(() => senderRouteKind(sender, s.id), { timeout: 30_000 }).toMatch(/^relay/);
    await pace(rx, s.id, 0);
    expect(await downloadAndHash(rx, name)).toBe(f.sha256);
  });
}

test('a direct path that stops mid-transfer migrates to the relay and resumes from the bitmap', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'chromium-desktop');
  test.setTimeout(8 * 60_000);
  const f = fixture('96M', 'migrate.bin');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  const rx = await receiverPage(browser, browserName);
  pages = [sender, rx];
  await joinToSave(rx, s.code);
  // Slow the receiver so the transfer is still running when the direct path is cut.
  await pace(rx, s.id, 40);
  await startInBrowser(rx);
  const chip = rx.getByTestId('route-chip');
  await expect(chip).toHaveAttribute('data-route', 'direct', { timeout: 60_000 });
  await expect.poll(() => rxVerified(rx, s.id), { timeout: 120_000 }).toBeGreaterThan(8 * MiB);
  const before = await rxVerified(rx, s.id);
  await rx.evaluate((id) => {
    const w = window as unknown as {
      __saTest: { receivers: Record<string, { testBlockDirect(): void; pace: { ms: number } }> };
    };
    const r = w.__saTest.receivers[id];
    if (!r) throw new Error('no receiver hook');
    r.testBlockDirect();
    r.pace.ms = 0;
  }, s.id);
  await expect(chip).toHaveAttribute('data-route', 'relay', { timeout: 120_000 });
  // The connection log records the move (shown in the receiver's connection log).
  const keys = await rx.evaluate((id) => {
    const w = window as unknown as { __saTest: { receivers: Record<string, { state: { log: { key: string }[] } }> } };
    return w.__saTest.receivers[id]?.state.log.map((l) => l.key) ?? [];
  }, s.id);
  expect(keys).toContain('product.log_route_switch');
  expect(await downloadAndHash(rx, 'migrate.bin')).toBe(f.sha256);
  // Resumed from the bitmap: no block verified twice, and the bytes before the cut were kept.
  expect((await receiverCounters(rx, s.id)).duplicates).toBe(0);
  expect(before).toBeGreaterThan(0);
});
