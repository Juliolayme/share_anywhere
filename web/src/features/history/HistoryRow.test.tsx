import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/i18n';
import { HistoryRow, entryTitle, historyPath } from './HistoryRow';
import { makeTranslate } from '../../i18n/i18n';
import * as en from '../../i18n/catalog-en';
import type { HistoryEntry } from './store/history-store';

const base: HistoryEntry = {
  id: 'rx:1',
  direction: 'received',
  title: 'trip.mp4',
  fileCount: 1,
  totalBytes: 10_000_000,
  peer: 'Minh',
  status: 'completed',
  createdAt: Date.UTC(2026, 10, 10),
};

function row(e: HistoryEntry, props: { compact?: boolean; to?: string } = {}) {
  return render(
    <I18nProvider initial="en">
      <MemoryRouter>
        <ul>
          <HistoryRow entry={e} {...props} />
        </ul>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const t = makeTranslate(en as never);

describe('HistoryRow', () => {
  it('shows the size of a completed transfer', () => {
    row({ ...base, transferredBytes: 10_000_000 });
    expect(screen.getByText('10.0 MB')).toBeInTheDocument();
  });

  it('shows transferred vs. size for a partial transfer', () => {
    row({ ...base, status: 'partial', transferredBytes: 4_000_000 });
    expect(screen.getByText('4.00 MB of 10.0 MB')).toBeInTheDocument();
    expect(screen.getByText('Partially completed')).toBeInTheDocument();
  });

  it('labels the peer with the direction, as the design does, and lists every receiver', () => {
    row({ ...base, direction: 'sent', peer: 'A, B', peers: ['Minh', 'Lan'] });
    expect(screen.getByText(/^Sent to Minh, Lan · /)).toBeInTheDocument();
  });

  it('opens the detail view when given a route', () => {
    row(base, { to: historyPath('rx:1') });
    expect(screen.getByRole('link', { name: /trip\.mp4/ })).toHaveAttribute('href', '/history/rx%3A1');
  });

  it('is plain text without a route', () => {
    row(base);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('entryTitle', () => {
  it('summarises extra files and falls back to a count without a name', () => {
    expect(entryTitle(base, t)).toBe('trip.mp4');
    expect(entryTitle({ ...base, fileCount: 2 }, t)).toBe('trip.mp4 + 1 file');
    expect(entryTitle({ ...base, fileCount: 3 }, t)).toBe('trip.mp4 + 2 files');
    expect(entryTitle({ ...base, title: '', fileCount: 4 }, t)).toBe('4 files');
    expect(entryTitle({ ...base, title: '', files: [{ name: 'a.bin', size: 1 }] }, t)).toBe('a.bin');
  });
});
