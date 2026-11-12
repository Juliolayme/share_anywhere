import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { chromiumWebRtc } from '../../playwright.config';
import { closeContexts, closeSenderBrowser, createSession, guestPage, senderPage } from '../pairing/helpers';
import {
  MiB,
  closeReceiverBrowsers,
  downloadAndHash,
  fixture,
  joinToSave,
  receiverPage,
  startInBrowser,
} from '../transfer/helpers';

// Throughput benchmark (docs/phases/PHASE_9_HARDENING_RELEASE.md, nightly `throughput`): a 256 MiB file from a
// Chromium sender to a receiver in this project's engine, per route: direct in every desktop engine, and relay over
// UDP and over TLS (CI coturn on loopback) in Chromium. Wall time from Start receiving to the verified result, so
// it includes hashing and storage writes. Results are appended to E2E_BENCH_OUT (JSON) for docs/PERFORMANCE.md.
// Loopback numbers bound the engine and the browser, not a real network.
test.skip(!process.env.E2E_BENCH, 'nightly throughput job only (E2E_BENCH=1)');
test.skip(({ isMobile }) => isMobile, 'desktop engines');
test.afterAll(closeSenderBrowser);
test.afterEach(async () => {
  await closeReceiverBrowsers();
  await closeContexts();
});
let tlsBrowser: Browser | null = null;
test.afterAll(async () => {
  await tlsBrowser?.close();
});

async function forceRelay(page: Page, step?: 'relay-udp' | 'relay-tls') {
  await page.addInitScript((s) => {
    const w = window as unknown as { __SA_TEST_ICE_POLICY?: string; __SA_TEST_ROUTE_STEP?: string };
    w.__SA_TEST_ICE_POLICY = 'relay';
    if (s) w.__SA_TEST_ROUTE_STEP = s;
  }, step);
}

function record(row: Record<string, unknown>) {
  const out = process.env.E2E_BENCH_OUT;
  if (!out) return;
  const rows = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as unknown[]) : [];
  rows.push(row);
  writeFileSync(out, JSON.stringify(rows, null, 2));
}

const SIZE = '256M';

for (const route of ['direct', 'relay-udp', 'relay-tls'] as const) {
  test(`throughput: 256 MiB over ${route}`, async ({ browser, browserName }) => {
    test.skip(route !== 'direct' && browserName !== 'chromium', 'relay runs in Chromium (loopback TURN)');
    test.skip(route !== 'direct' && !process.env.E2E_TURN, 'relay needs the CI coturn (E2E_TURN=1)');
    test.setTimeout(10 * 60_000);
    const name = `bench-${route}-${browserName}.bin`;
    const f = fixture(SIZE, name);
    const sender = await senderPage();
    if (route !== 'direct') await forceRelay(sender);
    const s = await createSession(sender, { files: [f.path] });
    tlsBrowser ??=
      route === 'relay-tls'
        ? await chromium.launch({ args: [...chromiumWebRtc.args, '--ignore-certificate-errors'] })
        : null;
    const rx =
      route === 'relay-tls' && tlsBrowser ? await guestPage(tlsBrowser) : await receiverPage(browser, browserName);
    if (route !== 'direct') await forceRelay(rx, route);
    await joinToSave(rx, s.code);
    const t0 = Date.now();
    await startInBrowser(rx);
    await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 9 * 60_000 });
    const seconds = (Date.now() - t0) / 1000;
    expect(await downloadAndHash(rx, name)).toBe(f.sha256);
    const mbps = f.size / MiB / seconds;
    test
      .info()
      .annotations.push({ type: 'throughput', description: `${route} → ${browserName}: ${mbps.toFixed(1)} MiB/s` });
    record({
      route,
      receiver: browserName,
      bytes: f.size,
      seconds: Number(seconds.toFixed(2)),
      mib_per_s: Number(mbps.toFixed(1)),
    });
  });
}
