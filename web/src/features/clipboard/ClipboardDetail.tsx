import { Copy, Globe, Lock, LockKeyhole, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { formatDateTime } from '../../lib/format';
import type { ClipItem } from './engine';

/** Selects the text of `el` so the user can copy it by hand (Copy fallback). */
export function selectText(el: HTMLElement | null) {
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * CB-5 / design `clipboard` drawer at `/clipboard/:eventId`: origin device and time, the full text (decrypted on this
 * device), its length, Copy (writeText from the click, with a manual-copy fallback) and Delete on every device.
 */
export function ClipboardDetail({
  item,
  origin,
  copyFailed,
  busy,
  onCopy,
  onDelete,
  onClose,
}: {
  item: ClipItem;
  origin: string;
  /** Copy from the list failed: the text is selected here for a manual copy. */
  copyFailed: boolean;
  busy: boolean;
  onCopy: () => Promise<boolean>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [failed, setFailed] = useState(copyFailed);

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

  useEffect(() => {
    if (failed) selectText(textRef.current);
  }, [failed]);

  const chars = item.text === null ? 0 : [...item.text].length;
  return (
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
        data-testid="cb-detail"
        className="box-border flex h-full w-full max-w-full flex-col gap-4 overflow-auto border-l border-border bg-surface p-[20px] shadow-e2 rail:w-[420px]"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="m-0 text-title">
            {t('common.cb_detail')}
          </h2>
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
        <span className="flex flex-wrap items-center gap-2 text-caption text-fg-2">
          <Globe aria-hidden size={14} />
          <b className="text-fg" data-testid="cb-detail-origin">
            {origin}
          </b>
          · {formatDateTime(item.createdAt, locale)}
        </span>
        {item.text === null ? (
          <p className="m-0 flex items-start gap-2 rounded-lg border border-border bg-bg p-4 text-[14px] italic text-fg-2">
            <Lock aria-hidden size={16} className="mt-[3px] flex-none" />
            {t('product.cb_locked')}
          </p>
        ) : (
          <div
            ref={textRef}
            data-testid="cb-detail-text"
            className="whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-4 text-[15px] leading-[1.6]"
          >
            {item.text}
          </div>
        )}
        {failed && (
          <p role="alert" className="m-0 text-caption text-danger-ink">
            {t('product.cb_copy_failed')}
          </p>
        )}
        <div className="flex flex-wrap gap-3 text-[12px] text-fg-2">
          {item.text !== null && (
            <span>
              {new Intl.NumberFormat(locale).format(chars)}
              {t('common.chars')}
            </span>
          )}
          <span className="inline-flex items-center gap-1 font-semibold text-receive-ink">
            <LockKeyhole aria-hidden size={12} />
            {t('web.e2e')}
          </span>
        </div>
        <div className="mt-auto flex gap-2">
          {item.text !== null && (
            <Button
              variant="send"
              icon={Copy}
              className="flex-1"
              onClick={async () => {
                const ok = await onCopy();
                setFailed(!ok);
              }}
            >
              {t('web.copy')}
            </Button>
          )}
          <Button variant="danger-ghost" icon={Trash2} busy={busy} onClick={onDelete}>
            {t('common.del')}
          </Button>
        </div>
      </aside>
    </div>
  );
}
