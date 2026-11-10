import { expect, test } from '@playwright/test';
import { closeSenderBrowser, createSession, senderPage } from '../pairing/helpers';
import { downloadAndHash, fixture, joinToSave, receiverPage } from '../transfer/helpers';

test.skip(({ isMobile }) => !isMobile, 'mobile projects only');
test.afterAll(closeSenderBrowser);

test('receive (mobile): the capability check shows this browser’s row and an 8 MB file arrives through browser storage', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const f = fixture('8M');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  const rx = await receiverPage(browser, browserName);
  await joinToSave(rx, s.code);
  const row = rx.getByTestId('capability-row');
  await expect(row).toHaveAttribute('data-family', browserName === 'webkit' ? 'safari' : 'chromium');
  await expect(row).toHaveAttribute('data-opfs', 'true');
  if (browserName === 'webkit') {
    await expect(row).toHaveAttribute('data-folder', 'false');
    await expect(
      rx.getByText(
        'On iPhone and iPad, keep this tab open and the screen on: Safari pauses transfers in the background.',
      ),
    ).toBeVisible();
  } else {
    await expect(
      rx.getByText('Keep this tab in front: mobile browsers slow down or pause background tabs.'),
    ).toBeVisible();
  }
  await rx.getByTestId('save-opfs').click();
  await rx.getByRole('button', { name: 'Start receiving' }).click();
  await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 90_000 });
  const overflow = await rx.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await downloadAndHash(rx, f.path.split('/').pop() ?? '')).toBe(f.sha256);
  await sender.context().close();
  await rx.context().close();
});
