import { expect, test, type Locator, type Page } from '@playwright/test';
import { openAsReturningGuest } from '../fixtures';

// HI-1 / HI-2 (docs/UX_SCREEN_MAP.md §6, PRD §5.6): local History as a guest. Entries are seeded straight into the
// app's IndexedDB store (database "share-anywhere", object store "history", keyPath "id"), the same records the
// transfer controllers write, so the spec covers the screen without running transfers.

const DAY = 86_400_000;

function seedEntries(now: number) {
  return [
    {
      id: 'tx:e2e-deck',
      direction: 'sent',
      title: 'Pitch_deck_v12.pdf',
      fileCount: 2,
      totalBytes: 30_000_000,
      transferredBytes: 30_000_000,
      peer: 'Studio iMac, Lan’s MacBook',
      peers: ['Studio iMac', 'Lan’s MacBook'],
      files: [
        { name: 'Pitch_deck_v12.pdf', size: 24_600_000 },
        { name: 'speaker_notes.txt', size: 5_400_000 },
      ],
      route: 'direct',
      startedAt: now - 60_000 - 2_000,
      status: 'completed',
      createdAt: now - 60_000,
    },
    {
      id: 'rx:e2e-wedding',
      direction: 'received',
      title: 'Wedding_photos.zip',
      fileCount: 1,
      totalBytes: 6_200_000_000,
      transferredBytes: 4_100_000_000,
      peer: 'Lan’s MacBook',
      status: 'partial',
      createdAt: now - 3 * DAY,
    },
    {
      // Written before Phase 4: no peers, files, route or start time.
      id: 'rx:e2e-drone',
      direction: 'received',
      title: 'Drone_B-roll.mp4',
      fileCount: 1,
      totalBytes: 5_870_000_000,
      peer: 'Office PC',
      status: 'failed',
      createdAt: now - 12 * DAY,
    },
    {
      id: 'tx:e2e-apk',
      direction: 'sent',
      title: 'App_release_1.4.apk',
      fileCount: 1,
      totalBytes: 182_000_000,
      transferredBytes: 64_000_000,
      peer: 'Tuấn’s Galaxy A14',
      status: 'cancelled',
      createdAt: now - 20 * DAY,
    },
    {
      // Older than the default 30-day retention: the sweep on load deletes it.
      id: 'rx:e2e-expired',
      direction: 'received',
      title: 'Expired_backup.tar',
      fileCount: 1,
      totalBytes: 1_000_000,
      peer: 'Office PC',
      status: 'completed',
      createdAt: now - 40 * DAY,
    },
  ];
}

/** Opens History as a returning guest, writes the seed entries into IndexedDB, and reloads. */
async function openSeeded(page: Page) {
  await openAsReturningGuest(page, '/history');
  // The empty state means the app has opened (and created) its IndexedDB store.
  await expect(page.getByTestId('history-empty')).toBeVisible();
  await page.evaluate(async (entries) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('share-anywhere');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('history', 'readwrite');
      for (const e of entries) tx.objectStore('history').put(e);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, seedEntries(Date.now()));
  await page.reload();
  await expect(rows(page)).toHaveCount(4);
}

const rows = (page: Page) => page.getByTestId('history-row');

/** Replaces a field's text with real keystrokes: fill() does not reach React's onChange under WebDriver BiDi. */
async function typeInto(field: Locator, text: string) {
  await field.click();
  await field.press('ControlOrMeta+a');
  await field.press('Backspace');
  if (text) await field.pressSequentially(text);
}

async function storedIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open('share-anywhere');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('history', 'readonly').objectStore('history').getAllKeys();
          all.onsuccess = () => {
            db.close();
            resolve((all.result as string[]).sort());
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

test('history: retention sweep, search, filters and no-match state', async ({ page }) => {
  await openSeeded(page);
  await expect(page.locator('[data-screen="history"]')).toHaveCount(1);
  // Newest first; the 40-day-old entry was swept by the 30-day retention default, in the UI and in storage.
  await expect(rows(page).first()).toContainText('Pitch_deck_v12.pdf + 1 file');
  await expect(rows(page).first()).toContainText('Sent to Studio iMac, Lan’s MacBook');
  await expect(rows(page).nth(1)).toContainText('4.10 GB of 6.20 GB');
  await expect(page.getByText('Expired_backup.tar')).toHaveCount(0);
  expect(await storedIds(page)).not.toContain('rx:e2e-expired');

  // Search matches a file name inside a multi-file entry, and peers.
  const search = page.getByRole('searchbox', { name: 'Search files or devices' });
  await typeInto(search, 'speaker_notes');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pitch_deck_v12.pdf');
  await typeInto(search, 'office');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Drone_B-roll.mp4');
  await typeInto(search, 'no-such-file');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText('No transfers here')).toBeVisible();
  await typeInto(search, '');
  await expect(rows(page)).toHaveCount(4);

  // Direction tabs (keyboard too).
  await page.getByRole('tab', { name: 'Received' }).click();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('tab', { name: 'Received' }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(4);

  // Status, date and device filters.
  const status = page.getByRole('combobox', { name: 'Filter by status' });
  await status.selectOption('cancelled');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('App_release_1.4.apk');
  await status.selectOption('any');

  const date = page.getByRole('combobox', { name: 'Filter by date' });
  await date.selectOption('7d');
  await expect(rows(page)).toHaveCount(2);
  await date.selectOption('today');
  await expect(rows(page)).toHaveCount(1);
  await date.selectOption('all');

  const device = page.getByRole('combobox', { name: 'Filter by device' });
  await device.selectOption('Lan’s MacBook');
  await expect(rows(page)).toHaveCount(2);
  await device.selectOption('Office PC');
  await expect(rows(page)).toHaveCount(1);
  await device.selectOption('');
  await expect(rows(page)).toHaveCount(4);
});

test('history: detail drawer, delete one entry, then clear all', async ({ page }) => {
  await openSeeded(page);

  // Open from the row: the drawer shows every recorded field and the URL names the entry.
  await rows(page).first().getByRole('link').click();
  const detail = page.getByRole('dialog', { name: 'Pitch_deck_v12.pdf + 1 file' });
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(/\/history\/tx%3Ae2e-deck$/);
  await expect(detail.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(detail.locator('dt', { hasText: 'Sent to' }).locator('+ dd')).toHaveText('Studio iMac, Lan’s MacBook');
  await expect(detail.locator('dt', { hasText: 'Original size' }).locator('+ dd')).toHaveText('30.0 MB');
  await expect(detail.locator('dt', { hasText: 'Route' }).locator('+ dd')).toHaveText('Connected directly');
  await expect(detail.locator('dt', { hasText: 'Duration' }).locator('+ dd')).toHaveText('2 sec');
  await expect(detail.getByText('SHA-256 checked')).toBeVisible();
  await expect(detail.getByText('speaker_notes.txt')).toBeVisible();

  // Escape closes and focus returns to the row.
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(page).toHaveURL(/\/history$/);
  await expect(rows(page).first().getByRole('link')).toBeFocused();

  // A partial entry: transferred vs. original size, not verified; then delete it.
  await rows(page).nth(1).getByRole('link').click();
  const partial = page.getByRole('dialog', { name: 'Wedding_photos.zip' });
  await expect(partial.getByTestId('history-detail-transferred')).toHaveText('4.10 GB of 6.20 GB');
  await expect(partial.getByText('Incomplete — not verified')).toBeVisible();
  await partial.getByRole('button', { name: 'Delete from history' }).click();
  await expect(partial).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Removed from history' })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByText('Wedding_photos.zip')).toHaveCount(0);

  // The deletion is stored: it survives a reload.
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  expect(await storedIds(page)).toEqual(['rx:e2e-drone', 'tx:e2e-apk', 'tx:e2e-deck']);

  // A direct link opens the drawer; the Close button closes it.
  await page.goto('/history/rx%3Ae2e-drone');
  const legacy = page.getByRole('dialog', { name: 'Drone_B-roll.mp4' });
  await expect(legacy).toBeVisible();
  await expect(legacy.locator('dt', { hasText: 'Received from' }).locator('+ dd')).toHaveText('Office PC');
  await expect(legacy.locator('dt', { hasText: 'Route' })).toHaveCount(0);
  await legacy.getByRole('button', { name: 'Close' }).click();
  await expect(legacy).toHaveCount(0);

  // Clear all, with confirmation.
  await page.getByRole('button', { name: 'Clear history' }).click();
  const confirm = page.getByRole('dialog', { name: 'Clear transfer history?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByText('No transfers yet')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'History cleared' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('No transfers yet')).toBeVisible();
  expect(await storedIds(page)).toEqual([]);
});

test('history: Vietnamese strings', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('sa.pref.lang', 'vi');
    } catch {
      /* storage blocked */
    }
  });
  await openSeeded(page);
  await expect(page.getByRole('heading', { name: 'Lịch sử', level: 1 })).toBeVisible();
  await expect(rows(page).first()).toContainText('Pitch_deck_v12.pdf + 1 tệp');
  await rows(page).first().getByRole('link').click();
  const detail = page.getByRole('dialog', { name: 'Pitch_deck_v12.pdf + 1 tệp' });
  await expect(detail.getByText('Kích thước gốc')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Xoá khỏi lịch sử' })).toBeVisible();
});
