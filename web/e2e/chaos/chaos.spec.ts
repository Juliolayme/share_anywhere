import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { BASE, closeContexts, closeSenderBrowser, createSession, enterCode, senderPage } from '../pairing/helpers';
import {
  closeReceiverBrowsers,
  downloadAndHash,
  fixture,
  joinToSave,
  receiverPage,
  rxVerified,
  senderHook,
  startInBrowser,
} from '../transfer/helpers';

// Failure injection (docs/phases/PHASE_9_HARDENING_RELEASE.md, nightly `chaos`): parts of the CI stack are restarted
// or stopped while guests are in a session, through Docker Compose on the runner. Each test checks the user-visible
// outcome: transfers carry on peer to peer, the app recovers its server connection, and nothing is lost.
// Runs only with E2E_CHAOS=1; E2E_COMPOSE overrides the compose command (default: the CI stack from the web folder).
test.skip(!process.env.E2E_CHAOS, 'failure injection: E2E_CHAOS=1');
test.skip(({ isMobile }) => isMobile, 'desktop Chromium receiver');
test.afterAll(closeSenderBrowser);
test.afterEach(async () => {
  await closeReceiverBrowsers();
  await closeContexts();
  for (const svc of ['postgres']) {
    try {
      compose('unpause', svc);
    } catch {
      /* not paused */
    }
  }
  compose('start', 'backend', 'postgres', 'coturn', 'caddy'); // whatever a failed test left stopped
  await healthy();
});

function compose(...args: string[]) {
  const base = (process.env.E2E_COMPOSE ?? 'docker compose -f ../docker-compose.ci.yml').split(' ');
  const [cmd, ...rest] = base;
  execFileSync(cmd ?? 'docker', [...rest, ...args], { stdio: 'pipe', timeout: 120_000 });
}

/** Waits until the backend answers /readyz (database reachable) through the edge proxy. */
async function healthy(timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/readyz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the backend did not become ready');
}

const nameOf = (path: string) => path.split('/').pop() ?? '';
const result = (rx: Page) => rx.getByTestId('receive-result');

test('chaos: a backend restart mid-transfer does not stop the transfer; reports catch up', async ({ browser }) => {
  test.setTimeout(240_000);
  const f = fixture('64M');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  await senderHook(sender, s.id, { pace: 600 }); // 16 blocks: about 10 s, so the restart lands mid-transfer
  const rx = await receiverPage(browser, 'chromium');
  await joinToSave(rx, s.code);
  await startInBrowser(rx);
  await expect.poll(() => rxVerified(rx, s.id), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await rxVerified(rx, s.id), 'still transferring when the backend goes down').toBeLessThan(f.size);
  compose('restart', 'backend');
  await senderHook(sender, s.id, { pace: 0 }).catch(() => undefined); // the hook needs the backend: best effort
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 180_000 });
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
  await healthy();
  // The reports the restart interrupted are retried: the sender's dashboard ends completed from the server's view.
  await sender.goto(`/send/session/${s.id}/transfers`);
  await expect(sender.getByTestId('final-banner')).toHaveAttribute('data-final', 'completed', { timeout: 60_000 });
});

test('chaos: the database is unreachable for a while and drops every connection; a receiver joins once it is back', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const sender = await senderPage();
  const s = await createSession(sender);
  // An outage as the backend sees a database restart: unreachable for a few seconds, then every connection is
  // terminated (the CI database keeps its data in memory, so restarting its container would wipe it).
  compose('pause', 'postgres');
  await new Promise((r) => setTimeout(r, 8000));
  compose('unpause', 'postgres');
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'shareanywhere',
    '-d',
    'shareanywhere',
    '-c',
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = 'shareanywhere'",
  );
  await healthy();
  const rx = await receiverPage(browser, 'chromium');
  await enterCode(rx, s.code);
  await expect(rx.locator('[data-screen="receive-preview"]')).toBeVisible({ timeout: 30_000 });
  await rx.getByRole('button', { name: 'Receive' }).click();
  await expect(rx.locator('[data-screen="receive-save"]')).toBeVisible({ timeout: 30_000 });
  // The sender's screen hears about the receiver over its WebSocket.
  await expect(sender.getByTestId('participant-card')).toHaveCount(1, { timeout: 60_000 });
});

test('chaos: with coturn down, a direct transfer still completes and the relay is not needed', async ({ browser }) => {
  test.setTimeout(180_000);
  compose('stop', 'coturn');
  const f = fixture('8M');
  const sender = await senderPage();
  const s = await createSession(sender, { files: [f.path] });
  const rx = await receiverPage(browser, 'chromium');
  await joinToSave(rx, s.code);
  await startInBrowser(rx);
  await expect(result(rx)).toHaveAttribute('data-result', 'completed', { timeout: 120_000 });
  expect(await downloadAndHash(rx, nameOf(f.path))).toBe(f.sha256);
});

test('chaos: the edge proxy flaps (WebSockets drop); the sender sees a receiver who joins afterwards', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const sender = await senderPage();
  const s = await createSession(sender);
  compose('restart', 'caddy');
  await healthy();
  const rx = await receiverPage(browser, 'chromium');
  await joinToSave(rx, s.code);
  await expect(sender.getByTestId('participant-card')).toHaveCount(1, { timeout: 60_000 });
});
