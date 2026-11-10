import { ArrowDownLeft, ArrowUpRight, Ban, CircleAlert, CircleCheck, CircleX, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n, type Translate } from '../../i18n/i18n';
import { entryPeers, type HistoryEntry, type HistoryStatus } from './store/history-store';
import { formatBytes, formatWhen } from '../../lib/format';

const CHIP: Record<HistoryStatus, { cls: string; icon: LucideIcon }> = {
  completed: { cls: 'bg-receive-soft text-receive-ink', icon: CircleCheck },
  partial: { cls: 'bg-warning-soft text-warning-ink', icon: CircleAlert },
  failed: { cls: 'bg-danger-soft text-danger-ink', icon: CircleX },
  cancelled: { cls: 'bg-surface-2 text-fg-2', icon: Ban },
};

export function StatusChip({ status }: { status: HistoryStatus }) {
  const { t } = useI18n();
  const { cls, icon: Icon } = CHIP[status];
  return (
    <span
      className={`inline-flex h-[24px] flex-none items-center gap-[5px] rounded-[7px] px-2 text-[12px] font-semibold ${cls}`}
    >
      <Icon aria-hidden size={14} />
      {t(`web.st.${status}`)}
    </span>
  );
}

/** Route of the detail view (HI-2) for an entry. */
export const historyPath = (id: string) => `/history/${encodeURIComponent(id)}`;

/** The row title as the design writes it: "Project.mov + 2 files" for a multi-file transfer. */
export function entryTitle(e: HistoryEntry, t: Translate): string {
  const name = e.title || e.files?.[0]?.name || '';
  if (!name) return e.fileCount === 1 ? t('product.files_count_one') : t('product.files_count', { n: e.fileCount });
  const more = e.fileCount - 1;
  if (more <= 0) return name;
  return more === 1
    ? t('product.history_title_more_one', { name })
    : t('product.history_title_more', { name, n: more });
}

/** "Sent to" / "Received from" as the design labels the peer. */
export function directionLabel(e: HistoryEntry, t: Translate): string {
  return t(e.direction === 'sent' ? 'phrases.sent_to' : 'phrases.received_from');
}

/** Size column: transferred vs. size when the transfer ended short, else the size. */
export function bytesLabel(transferred: number | undefined, total: number, t: Translate, locale: string): string {
  return transferred !== undefined && transferred < total
    ? t('product.history_partial_bytes', { done: formatBytes(transferred, locale), total: formatBytes(total, locale) })
    : formatBytes(total, locale);
}

export function DirectionIcon({ entry, size = 40 }: { entry: HistoryEntry; size?: number }) {
  const sent = entry.direction === 'sent';
  const Icon = sent ? ArrowUpRight : ArrowDownLeft;
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={`flex flex-none items-center justify-center rounded-md ${sent ? 'bg-send-soft text-send-ink' : 'bg-receive-soft text-receive-ink'}`}
    >
      <Icon size={Math.round(size * 0.45)} />
    </span>
  );
}

/**
 * One local history entry (design `history` row; compact on Transfer home). With `to`, the row is a link that
 * opens the detail view (HI-2).
 */
export function HistoryRow({
  entry,
  compact,
  to,
  keepFocus,
}: {
  entry: HistoryEntry;
  compact?: boolean;
  to?: string;
  /** Opening the drawer from the History list itself: focus moves into the drawer, not to the page. */
  keepFocus?: boolean;
}) {
  const { t, locale } = useI18n();
  const peers = entryPeers(entry).join(', ');
  const body = (
    <>
      <DirectionIcon entry={entry} size={compact ? 38 : 40} />
      <span className={compact ? 'min-w-0 flex-1' : 'min-w-[160px] flex-1'}>
        <b className="block truncate text-[14px]">{entryTitle(entry, t)}</b>
        <span className="text-[12px] text-fg-2">
          {compact ? peers : `${directionLabel(entry, t)} ${peers}`} · {formatWhen(entry.createdAt, locale)}
        </span>
      </span>
      {!compact && (
        <span className="min-w-[100px] text-right font-mono text-[12px] text-fg-2">
          {bytesLabel(entry.transferredBytes, entry.totalBytes, t, locale)}
        </span>
      )}
      <StatusChip status={entry.status} />
    </>
  );
  const layout = `flex flex-wrap items-center gap-3 text-fg ${compact ? 'rounded-[12px] px-3 py-[10px]' : 'px-[18px] py-[14px]'}`;
  return (
    <li className={compact ? '' : 'border-b border-border last:border-b-0'} data-testid="history-row">
      {to ? (
        <Link
          to={to}
          state={keepFocus ? { keepFocus: true } : undefined}
          className={`${layout} no-underline hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:[outline-offset:-3px]`}
        >
          {body}
        </Link>
      ) : (
        <div className={layout}>{body}</div>
      )}
    </li>
  );
}
