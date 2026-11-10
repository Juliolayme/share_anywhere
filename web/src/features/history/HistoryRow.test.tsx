import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/i18n';
import { HistoryRow } from './HistoryRow';
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

function row(e: HistoryEntry) {
  return render(
    <I18nProvider initial="en">
      <ul>
        <HistoryRow entry={e} />
      </ul>
    </I18nProvider>,
  );
}

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
});
