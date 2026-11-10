import { ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { bytesLabel, directionLabel, DirectionIcon, entryTitle, StatusChip } from './HistoryRow';
import { entryPeers, transferredOf, type HistoryEntry } from './store/history-store';

const ROUTE_KEY = { direct: 'handoff.p2p', relay: 'handoff.relay', mixed: 'product.history_route_mixed' } as const;

/**
 * HI-2 / design `history` drawer: direction, peer, files, original size vs. transferred, route, duration, integrity,
 * and Delete from history. Fields an older entry did not record are left out rather than invented.
 */
export function HistoryDetail({
  entry,
  busy,
  onClose,
  onDelete,
}: {
  entry: HistoryEntry;
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href]');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
    };
  }, []);

  const transferred = transferredOf(entry);
  const verified = entry.status === 'completed';
  const duration =
    entry.startedAt !== undefined && entry.startedAt <= entry.createdAt ? entry.createdAt - entry.startedAt : undefined;
  const files = entry.files ?? [];
  const mono = 'm-0 font-mono text-[13px]';

  return (
    // The scrim closes on click like the design's drawer; keyboard users close with Escape or the Close button.
    <div
      role="presentation"
      className="fixed inset-0 z-40 flex justify-end bg-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="history-detail"
        className="box-border flex h-full w-full max-w-full flex-col gap-4 overflow-auto border-l border-border bg-surface p-[20px] shadow-e2 rail:w-[420px]"
      >
        <div className="flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-[40px] w-[40px] items-center justify-center rounded-md bg-surface-2 text-fg"
          >
            <X aria-hidden size={18} />
          </button>
        </div>
        <div className="flex items-center gap-3">
          <DirectionIcon entry={entry} size={44} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 break-words text-[16px] leading-snug">
              {entryTitle(entry, t)}
            </h2>
            <div className="text-caption text-fg-2">{formatDateTime(entry.createdAt, locale)}</div>
          </div>
        </div>
        <div className="self-start">
          <StatusChip status={entry.status} />
        </div>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-[10px] text-[14px]">
          <dt className="text-fg-2">{directionLabel(entry, t)}</dt>
          <dd className="m-0 break-words">{entryPeers(entry).join(', ')}</dd>
          <dt className="text-fg-2">{t('product.history_original_size')}</dt>
          <dd className={mono}>{formatBytes(entry.totalBytes, locale)}</dd>
          <dt className="text-fg-2">{t('web_xx.h_size')}</dt>
          <dd className={mono} data-testid="history-detail-transferred">
            {transferred === undefined ? '—' : bytesLabel(transferred, entry.totalBytes, t, locale)}
          </dd>
          {entry.route && (
            <>
              <dt className="text-fg-2">{t('product.history_route')}</dt>
              <dd className="m-0">{t(ROUTE_KEY[entry.route])}</dd>
            </>
          )}
          {duration !== undefined && (
            <>
              <dt className="text-fg-2">{t('product.history_duration')}</dt>
              <dd className="m-0">{formatDuration(duration, locale)}</dd>
            </>
          )}
          <dt className="text-fg-2">{t('web_xx.h_int')}</dt>
          <dd className="m-0 flex items-center gap-[6px]">
            {verified ? (
              <ShieldCheck aria-hidden size={16} className="text-receive-ink" />
            ) : (
              <ShieldAlert aria-hidden size={16} className="text-warning-ink" />
            )}
            {t(verified ? 'web_xx.h_ok' : 'web_xx.h_bad')}
          </dd>
        </dl>
        {files.length > 0 && (
          <section aria-labelledby={`${titleId}-files`} className="flex flex-col gap-2">
            <h3 id={`${titleId}-files`} className="m-0 text-[14px]">
              {files.length === 1 ? t('product.files_count_one') : t('product.files_count', { n: files.length })}
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1 rounded-md border border-border p-0">
              {files.map((f, i) => (
                <li
                  key={`${i}-${f.name}`}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 break-all text-[14px]">{f.name}</span>
                  <span className="font-mono text-[12px] text-fg-2">
                    {bytesLabel(f.transferredBytes, f.size, t, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="mt-auto flex flex-col gap-2">
          <Button
            variant="danger-ghost"
            size="lg"
            icon={Trash2}
            busy={busy}
            onClick={onDelete}
            className="border border-border-strong"
          >
            {t('web_xx.h_del')}
          </Button>
        </div>
      </aside>
    </div>
  );
}
