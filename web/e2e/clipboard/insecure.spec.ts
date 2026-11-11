import { chromium, expect, test, type Browser } from '@playwright/test';
import { closeContexts, open } from '../pairing/helpers';
import { clipboardCalls, clipboardPage } from './helpers';

// Plain HTTP (PRD §7.2): http://localhost counts as a secure context, so the app is opened under a test host name
// that Chromium resolves to 127.0.0.1 (`--host-resolver-rules`); the Compose CI edge proxy answers any host on :8080.
// Over plain HTTP the browser offers neither the clipboard API nor WebCrypto, so Clipboard says HTTPS is required.
// No backend origin or cookie setting is involved: the page never gets a device identity (WebCrypto is missing for
// the proof of work) and the Clipboard screen needs none to show this.
test.afterEach(closeContexts);
test.skip(
  ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
  'Mapping a test host name to 127.0.0.1 needs Chromium’s --host-resolver-rules switch; one desktop Chromium run covers this browser-independent rule',
);

const HOST = 'sa-insecure.test';
let insecureBrowser: Browser | null = null;
test.afterAll(async () => {
  await insecureBrowser?.close();
  insecureBrowser = null;
});

test('insecure context over plain HTTP: Clipboard shows "HTTPS required" and makes no clipboard call', async () => {
  const port = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').port || '80';
  insecureBrowser = await chromium.launch({
    channel: 'chromium',
    executablePath: chromium.executablePath(),
    args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--no-proxy-server'],
  });
  const page = await clipboardPage(insecureBrowser, { baseURL: `http://${HOST}:${port}` });
  await open(page, '/clipboard');
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await expect(page.getByText('HTTPS required')).toBeVisible();
  await expect(page.getByTestId('cb-https-required')).toContainText('https://');
  await expect(page.getByRole('button', { name: 'Sync Clipboard' })).toHaveCount(0);
  expect(await clipboardCalls(page)).toEqual({
    readText: 0,
    writeText: 0,
    read: 0,
    write: 0,
    query: 0,
    copyListeners: 0,
  });
});
