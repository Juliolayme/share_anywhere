import { ArrowDownLeft, ArrowUpRight, Ban, CircleAlert, CircleCheck, CircleX, type LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n/i18n';
import type { HistoryEntry, HistoryStatus } from './store/history-store';
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

/** One local history entry with transferred vs. size for partial transfers. The detail view (HI-2) is Phase 4. */
export function HistoryRow({ entry, compact }: { entry: HistoryEntry; compact?: boolean }) {
  const { t, locale } = useI18n();
  const sent = entry.direction === 'sent';
  const DirIcon = sent ? ArrowUpRight : ArrowDownLeft;
  return (
    <li
      className={`flex flex-wrap items-center gap-3 text-fg ${compact ? 'rounded-[12px] px-3 py-[10px]' : 'border-b border-border px-[18px] py-[14px]'}`}
    >
      <span
        aria-hidden
        className={`flex h-[40px] w-[40px] flex-none items-center justify-center rounded-md ${sent ? 'bg-send-soft text-send-ink' : 'bg-receive-soft text-receive-ink'}`}
      >
        <DirIcon size={18} />
      </span>
      <span className="min-w-[160px] flex-1">
        <b className="block truncate text-[14px]">{entry.title}</b>
        <span className="text-[12px] text-fg-2">
          {t(sent ? 'common.f_sent' : 'common.f_recv')} · {entry.peer} · {formatWhen(entry.createdAt, locale)}
        </span>
      </span>
      {!compact && (
        <span className="min-w-[100px] text-right font-mono text-[12px] text-fg-2">
          {entry.transferredBytes !== undefined && entry.transferredBytes < entry.totalBytes
            ? t('product.history_partial_bytes', {
                done: formatBytes(entry.transferredBytes, locale),
                total: formatBytes(entry.totalBytes, locale),
              })
            : formatBytes(entry.totalBytes, locale)}
        </span>
      )}
      <StatusChip status={entry.status} />
    </li>
  );
}
