import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeContexts, closeSenderBrowser, createSession, senderPage } from '../pairing/helpers';
import { downloadAndHash, fixture, joinToSave, receiverPage, startInBrowser } from '../transfer/helpers';

// Nightly only: Web ↔ native app transfers of a 64 MB fixture with SHA-256 checks, both directions. Used by
// android-web-interop (scripts/android-interop.sh, the Android emulator; docs/phases/PHASE_6_ANDROID.md) and
// ios-web-interop (scripts/ios-interop.sh, the iOS Simulator; docs/phases/PHASE_7_IOS.md). The scripts pass values
// between this spec and the native test through INTEROP_DIR (Web → app) and env (app → Web).
const DIR = process.env.INTEROP_DIR ?? '';
test.skip(!DIR, 'native interop jobs only (INTEROP_DIR)');
test.afterAll(async () => {
  // Closing a browser that held a 64 MB WebRTC session can take longer than the default hook time on the macOS
  // runner (ios-web-interop timed out here once after both transfers had passed).
  test.setTimeout(120_000);
  await closeSenderBrowser();
});
test.afterEach(closeContexts);

test('web sends a 64 MB file to the native app', async () => {
  test.skip(process.env.INTEROP_ROLE !== 'web-sender', 'INTEROP_ROLE=web-sender');
  test.setTimeout(15 * 60_000);
  const f = fixture('64M');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  mkdirSync(DIR, { recursive: true });
  // The script hands these to the native test and waits for the result.
  writeFileSync(join(DIR, 'web-session.json'), JSON.stringify({ code: s.code, sha256: f.sha256, id: s.id }));
  // Stay in the app: a reload would drop the picked file (the Web keeps it in memory), so the sender would answer
  // file_unreadable. View transfers appears once the native receiver has joined.
  await sender.getByRole('button', { name: 'View transfers' }).click({ timeout: 5 * 60_000 });
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 14 * 60_000 });
});

test('web receives a 64 MB file from the native app', async ({ browser, browserName }) => {
  test.skip(process.env.INTEROP_ROLE !== 'web-receiver', 'INTEROP_ROLE=web-receiver');
  test.setTimeout(15 * 60_000);
  const code = process.env.INTEROP_CODE ?? '';
  const sha = process.env.INTEROP_SHA256 ?? '';
  const name = process.env.INTEROP_NAME ?? '';
  expect(code).toMatch(/^\d{6}$/);
  const rx = await receiverPage(browser, browserName);
  await joinToSave(rx, code);
  await startInBrowser(rx);
  await expect(rx.getByTestId('receive-result')).toHaveAttribute('data-result', 'completed', { timeout: 14 * 60_000 });
  expect(await downloadAndHash(rx, name)).toBe(sha);
});
