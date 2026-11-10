import { expect, test, type Page } from '@playwright/test';
import { closeContexts, guestPage, open } from './helpers';

type Payload = { name: string; mimeType: string; buffer: Buffer };

// QA P1: a guest device may keep 2 sessions open (docs/SECURITY_MODEL.md §5). When Create hits the cap, the
// send screen lists the open sessions (GET /v1/sessions) with Open and Close, and Create works after a Close.
// Runs in the project's own browser so the panel is exercised in every engine.

/** Closes every open session of the page's device through the API, like the panel does (cleanup). */
async function closeOwnSessions(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const tok = await fetch('/v1/devices/token', { method: 'POST', headers: { 'X-SA-Refresh': '1' } });
    if (!tok.ok) return -1;
    const { access_token: token } = (await tok.json()) as { access_token: string };
    const headers = { Authorization: `Bearer ${token}` };
    const list = (await (await fetch('/v1/sessions', { headers })).json()) as { sessions: { id: string }[] };
    for (const s of list.sessions) await fetch(`/v1/sessions/${s.id}/close`, { method: 'POST', headers });
    return list.sessions.length;
  });
}

/** Creates a session from the send screen with in-memory files and returns its id (as the helpers' createSession). */
async function createWith(page: Page, files: Payload[]): Promise<string> {
  await open(page, '/send');
  await page.getByTestId('file-input').setInputFiles(files);
  await page.getByRole('button', { name: /Create share session/ }).click();
  await page.waitForURL(/\/send\/session\//);
  await expect(page.getByTestId('session-code')).toHaveText(/\d{3}/);
  return page.url().split('/').pop() ?? '';
}

let device: Page | null = null;

test.afterEach(async () => {
  if (device) await closeOwnSessions(device).catch(() => undefined);
  device = null;
  await closeContexts();
});

test('open-sessions: at the guest cap Create lists the 2 open sessions; Close one and Create succeeds', async ({
  browser,
}) => {
  const page = (device = await guestPage(browser, { wake: 'granted' }));
  const first = await createWith(page, [{ name: 'first.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1024, 1) }]);
  const second = await createWith(page, [
    { name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1024, 2) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.alloc(16, 3) },
  ]);

  await open(page, '/send');
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'third.zip', mimeType: 'application/zip', buffer: Buffer.alloc(512, 4) });
  await page.getByRole('button', { name: /Create share session/ }).click();
  await expect(page.getByRole('alert').first()).toHaveText('Close one of your open sessions before starting another.');

  const panel = page.getByRole('region', { name: 'Your open sessions' });
  await expect(panel).toContainText('This device can keep 2 sessions open at once.');
  const rows = panel.getByTestId('open-session');
  await expect(rows).toHaveCount(2);
  // Newest first, with title, receivers and code state.
  await expect(rows.nth(0)).toContainText('second.pdf + 1 file');
  await expect(rows.nth(1)).toContainText('first.mp4');
  await expect(rows.nth(0)).toContainText('0/5 receivers');
  await expect(rows.nth(0)).toContainText('Code open until');

  // Close the older one (keyboard: focus the button and press Enter), confirm in the dialog.
  await panel.getByRole('button', { name: 'Close first.mp4' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Close this session?' });
  await dialog.getByRole('button', { name: 'Close session' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByTestId('open-sessions-closed')).toHaveText(
    'Session closed. You can create the new session now.',
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('second.pdf + 1 file');

  await page.getByRole('button', { name: /Create share session/ }).click();
  await page.waitForURL(/\/send\/session\//);
  const third = page.url().split('/').pop() ?? '';
  expect([first, second]).not.toContain(third);
  await expect(page.getByTestId('session-code')).toHaveText(/\d/);

  // Open from the panel goes to that session (the cap is hit again: second + third are open).
  await open(page, '/send');
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'fourth.txt', mimeType: 'text/plain', buffer: Buffer.alloc(8, 5) });
  await page.getByRole('button', { name: /Create share session/ }).click();
  await expect(rows).toHaveCount(2);
  await panel.getByRole('button', { name: 'Open second.pdf + 1 file' }).click();
  await page.waitForURL(new RegExp(`/send/session/${second}$`));

  expect(await closeOwnSessions(page)).toBe(2);
});
