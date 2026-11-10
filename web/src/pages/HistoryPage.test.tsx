import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { renderApp } from '../test/render';
import { writePref } from '../lib/storage';
import { openHistoryStore, type HistoryEntry, type HistoryStore } from '../features/history/store/history-store';

const DAY = 86_400_000;
const now = Date.now();

const entries: HistoryEntry[] = [
  {
    id: 'tx:deck',
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
    startedAt: now - 60 * 60 * 1000 - 2000,
    status: 'completed',
    createdAt: now - 60 * 60 * 1000,
  },
  {
    id: 'rx:wedding',
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
    // An entry written before Phase 4: no peers, files, route or start time.
    id: 'rx:legacy',
    direction: 'received',
    title: 'Drone_B-roll.mp4',
    fileCount: 1,
    totalBytes: 5_870_000_000,
    peer: 'Office PC',
    status: 'failed',
    createdAt: now - 12 * DAY,
  },
];

async function seeded(list: HistoryEntry[] = entries): Promise<HistoryStore> {
  const store = openHistoryStore(new IDBFactory());
  for (const e of list) await store.add(e);
  return store;
}

const rows = () => screen.queryAllByTestId('history-row');

beforeEach(() => {
  writePref('welcomed', '1');
  writePref('historyRetention', '30');
});

describe('History (HI-1)', () => {
  it('lists entries newest first with transferred vs. size and the multi-file title', async () => {
    renderApp(<App />, { path: '/history', store: await seeded() });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(document.querySelector('[data-screen="history"]')).not.toBeNull();
    expect(rows()[0]).toHaveTextContent('Pitch_deck_v12.pdf + 1 file');
    expect(rows()[0]).toHaveTextContent('Sent to Studio iMac, Lan’s MacBook');
    expect(rows()[1]).toHaveTextContent('4.10 GB of 6.20 GB');
    expect(screen.getByTestId('history-count')).toHaveTextContent('3 transfers');
  });

  it('searches file names inside a multi-file entry and shows the no-match state', async () => {
    renderApp(<App />, { path: '/history', store: await seeded() });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const search = screen.getByRole('searchbox', { name: 'Search files or devices' });
    await userEvent.type(search, 'speaker');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('Pitch_deck_v12.pdf');
    expect(screen.getByTestId('history-count')).toHaveTextContent('1 transfer');
    await userEvent.clear(search);
    await userEvent.type(search, 'nothing-like-this');
    expect(rows()).toHaveLength(0);
    expect(screen.getByText('No transfers here')).toBeInTheDocument();
    expect(screen.getByText('Try another filter, or send something new.')).toBeInTheDocument();
  });

  it('filters by direction tab, status, date and device (each receiver of a multi-receiver entry)', async () => {
    renderApp(<App />, { path: '/history', store: await seeded() });
    await waitFor(() => expect(rows()).toHaveLength(3));
    await userEvent.click(screen.getByRole('tab', { name: 'Received' }));
    expect(rows()).toHaveLength(2);
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Sent' })).toHaveAttribute('aria-selected', 'true');
    expect(rows()).toHaveLength(1);
    await userEvent.click(screen.getByRole('tab', { name: 'All' }));

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'partial');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('Wedding_photos.zip');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'any');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by date' }), '7d');
    expect(rows()).toHaveLength(2);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by date' }), 'all');

    const device = screen.getByRole('combobox', { name: 'Filter by device' });
    expect(
      within(device)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All devices', 'Lan’s MacBook', 'Office PC', 'Studio iMac']);
    await userEvent.selectOptions(device, 'Lan’s MacBook');
    expect(rows()).toHaveLength(2);
  });

  it('applies the retention sweep from Settings when the page opens', async () => {
    const old: HistoryEntry = {
      ...(entries[2] as HistoryEntry),
      id: 'rx:old',
      title: 'old.iso',
      createdAt: now - 40 * DAY,
    };
    const store = await seeded([...entries, old]);
    renderApp(<App />, { path: '/history', store });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByText('old.iso')).toBeNull();
    expect((await store.list()).map((e) => e.id)).not.toContain('rx:old');
  });

  it('shows the empty state, and the storage-blocked error when IndexedDB is unavailable', async () => {
    const { unmount } = renderApp(<App />, { path: '/history', store: await seeded([]) });
    expect(await screen.findByText('No transfers yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear history' })).toBeDisabled();
    unmount();
    renderApp(<App />, { path: '/history', store: null });
    expect(await screen.findByRole('alert')).toHaveTextContent('History isn’t available');
  });

  it('clears all entries after confirmation', async () => {
    const store = await seeded();
    renderApp(<App />, { path: '/history', store });
    await waitFor(() => expect(rows()).toHaveLength(3));
    await userEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear transfer history?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(rows()).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Clear transfer history?' })).getByRole('button', {
        name: 'Clear history',
      }),
    );
    expect(await screen.findByText('No transfers yet')).toBeInTheDocument();
    expect(await screen.findByText('History cleared')).toBeInTheDocument();
    expect(await store.list()).toEqual([]);
  });
});

describe('History detail (HI-2)', () => {
  it('opens from a row, shows every recorded field, and returns focus to the row on Escape', async () => {
    renderApp(<App />, { path: '/history', store: await seeded() });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const link = screen.getByRole('link', { name: /Pitch_deck_v12\.pdf/ });
    await userEvent.click(link);
    const dialog = await screen.findByRole('dialog', { name: 'Pitch_deck_v12.pdf + 1 file' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    const dl = within(dialog);
    expect(dl.getByText('Sent to').nextElementSibling).toHaveTextContent('Studio iMac, Lan’s MacBook');
    expect(dl.getByText('Original size').nextElementSibling).toHaveTextContent('30.0 MB');
    expect(dl.getByText('Transferred').nextElementSibling).toHaveTextContent('30.0 MB');
    expect(dl.getByText('Route').nextElementSibling).toHaveTextContent('Connected directly');
    expect(dl.getByText('Duration').nextElementSibling).toHaveTextContent('2 sec');
    expect(dl.getByText('SHA-256 checked')).toBeInTheDocument();
    expect(dl.getByRole('heading', { name: '2 files' })).toBeInTheDocument();
    expect(dl.getByText('speaker_notes.txt')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('link', { name: /Pitch_deck_v12\.pdf/ })).toHaveFocus());
  });

  it('keeps the filters while an entry is open and hides fields an older entry did not record', async () => {
    renderApp(<App />, { path: '/history', store: await seeded() });
    await waitFor(() => expect(rows()).toHaveLength(3));
    await userEvent.type(screen.getByRole('searchbox'), 'drone');
    await userEvent.click(screen.getByRole('link', { name: /Drone_B-roll\.mp4/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Drone_B-roll.mp4' }));
    expect(dialog.getByText('Received from').nextElementSibling).toHaveTextContent('Office PC');
    expect(dialog.getByText('Transferred').nextElementSibling).toHaveTextContent('—');
    expect(dialog.queryByText('Route')).toBeNull();
    expect(dialog.queryByText('Duration')).toBeNull();
    expect(dialog.getByText('Incomplete — not verified')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('searchbox')).toHaveValue('drone');
    expect(rows()).toHaveLength(1);
  });

  it('opens from a direct link and deletes the entry from this device', async () => {
    const store = await seeded();
    renderApp(<App />, { path: '/history/rx%3Awedding', store });
    const dialog = within(await screen.findByRole('dialog', { name: 'Wedding_photos.zip' }));
    expect(dialog.getByText('Transferred').nextElementSibling).toHaveTextContent('4.10 GB of 6.20 GB');
    await userEvent.click(dialog.getByRole('button', { name: 'Delete from history' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Removed from history')).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText('Wedding_photos.zip')).toBeNull();
    expect((await store.list()).map((e) => e.id)).toEqual(['tx:deck', 'rx:legacy']);
  });

  it('falls back to the list for an entry that no longer exists', async () => {
    renderApp(<App />, { path: '/history/rx%3Agone', store: await seeded() });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a failed delete and keeps the entry', async () => {
    const store = await seeded();
    const failing: HistoryStore = {
      ...store,
      remove: () => Promise.reject(new Error('quota')),
    };
    renderApp(<App />, { path: '/history/rx%3Awedding', store: failing });
    const dialog = within(await screen.findByRole('dialog', { name: 'Wedding_photos.zip' }));
    await act(async () => {
      await userEvent.click(dialog.getByRole('button', { name: 'Delete from history' }));
    });
    expect(await screen.findByText('Couldn’t delete this entry. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Wedding_photos.zip' })).toBeInTheDocument();
  });
});
