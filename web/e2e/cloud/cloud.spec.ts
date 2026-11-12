import { expect, test, type Page } from '@playwright/test';
import { signUp, uniqueEmail } from '../account/helpers';
import { closeSenderBrowser, guestPage, open, senderPage } from '../pairing/helpers';
import {
  attachDiagnostics,
  closeReceiverBrowsers,
  downloadAndHash,
  fixture,
  joinToSave,
  receiverPage,
  startInBrowser,
} from '../transfer/helpers';

// Cloud Distribution on the Web (docs/phases/PHASE_8_ROUTE_TURN_CLOUD.md, docs/TRANSFER_PROTOCOL.md §9). The CI stack
// runs the backend with Cloud on and an S3-compatible store (docker-compose.ci.yml); no prices are configured, so the
// estimate is "Cost unknown".
test.afterAll(closeSenderBrowser);
const opened: Page[] = [];
test.afterEach(async () => {
  await attachDiagnostics(opened);
  opened.length = 0;
  await closeReceiverBrowsers();
});
test.skip(({ isMobile }) => isMobile, 'desktop flow; the mobile layouts are covered by e2e/mobile');

const track = (p: Page) => (opened.push(p), p);

/** A counter from the backend's internal metrics listener (published on the runner's loopback in the CI stack). */
async function metric(name: string): Promise<number> {
  const text = await (await fetch(process.env.E2E_METRICS_URL ?? 'http://127.0.0.1:9090/metrics')).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(' ')[1]) : -1;
}
const nameOf = (path: string) => path.split('/').pop() ?? '';

test('cloud: a guest sender sees Cloud transfer disabled with "Sign in to use Cloud transfer"', async ({ browser }) => {
  const page = track(await guestPage(browser));
  await open(page, '/send');
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'a.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10, 1) });
  const option = page.getByTestId('cloud-option');
  await expect(option).toBeVisible();
  await expect(option.getByRole('switch', { name: 'Cloud transfer' })).toBeDisabled();
  await expect(option.getByText('Sign in to use Cloud transfer')).toBeVisible();
});

test('cloud: a signed-in sender consents and uploads; a guest receiver finishes from the cloud after the sender leaves', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(240_000);
  const f = fixture('6M', 'cloud-6M.bin');
  const before = {
    cloud: await metric('sa_transfer_route_cloud_total'),
    deleted: await metric('sa_cloud_objects_deleted_total'),
  };
  const sender = track(await senderPage());
  await signUp(sender, uniqueEmail('cloud'), { add: false });

  // TR-3: choose Cloud transfer; the consent dialog shows the estimate first.
  await open(sender, '/send');
  await sender.getByTestId('file-input').setInputFiles(f.path);
  await sender.getByTestId('cloud-option').getByRole('switch', { name: 'Cloud transfer' }).click();
  const dialog = sender.getByRole('dialog', { name: 'Cloud transfer requires your approval' });
  await expect(dialog.getByTestId('cloud-estimate')).toBeVisible();
  await expect(dialog.getByTestId('cloud-cost')).toHaveText('Cost unknown');
  await expect(dialog.getByText(/Kept for up to 24 h/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve and use Cloud' }).click();
  await expect(dialog).toBeHidden();
  await expect(sender.getByTestId('cloud-option').getByRole('switch', { name: 'Cloud transfer' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await sender.getByRole('button', { name: /Create share session/ }).click();
  await sender.waitForURL(/\/send\/session\//);
  const code = (await sender.getByTestId('session-code').textContent())?.replace(/\D/g, '') ?? '';
  const id = sender.url().split('/').pop() ?? '';
  await expect(sender.getByTestId('cloud-upload')).toHaveAttribute('data-cloud-state', 'ready', { timeout: 60_000 });

  // The receiver joins while the sender is still here and gets the key over signaling.
  const rx = track(await receiverPage(browser, browserName));
  await joinToSave(rx, code);
  await expect
    .poll(
      () =>
        rx.evaluate(
          (sid) =>
            (window as unknown as { __saTest: { receivers: Record<string, { cloudReadyCount: number }> } }).__saTest
              .receivers[sid]?.cloudReadyCount ?? 0,
          id,
        ),
      { timeout: 30_000 },
    )
    .toBe(1);

  // The sender goes away (iOS suspended, laptop closed): P2P cannot connect, the cloud copy finishes the transfer.
  await sender.context().close();
  await startInBrowser(rx);
  await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  // The server recorded the route as cloud and deleted the object once the only receiver had it.
  await expect.poll(() => metric('sa_transfer_route_cloud_total')).toBeGreaterThan(before.cloud);
  await expect.poll(() => metric('sa_cloud_objects_deleted_total')).toBeGreaterThan(before.deleted);
  await rx.goto('/history');
  await expect(rx.getByText(nameOf(f.path))).toBeVisible();
});
