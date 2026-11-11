import {
  Check,
  CircleAlert,
  Clipboard,
  Clock,
  Copy,
  EyeOff,
  Globe,
  Lock,
  LockKeyhole,
  RefreshCw,
  Search,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { Banner, Button, ConfirmDialog, PageHeader, Screen } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { formatWhen } from '../../lib/format';
import { useIdentity } from '../../lib/identity/identity';
import { useClipboardState } from './ClipboardContext';
import { CaptureStatusPanel } from './CaptureStatusPanel';
import { ClipboardDetail } from './ClipboardDetail';
import type { CaptureResult, ClipItem, QueueReason } from './engine';
import { setAutoCapture } from './prefs';
import type { ClipboardRuntime } from './runtime';
import type { ReadFailure } from './capture';

const KEEP_FOCUS = { keepFocus: true };
type Filter = 'all' | 'mine' | 'others' | 'links';
const isLink = (text: string | null) => !!text && /^https?:\/\/\S+$/i.test(text.trim());

/** What the last Sync said, shown under the button (polite live region). */
type Notice = 'duplicate' | 'empty' | 'too_large' | 'paused' | 'not_ready';
const NOTICE_KEY: Record<Notice, string> = {
  duplicate: 'product.cb_duplicate',
  empty: 'product.cb_empty_clip',
  too_large: 'product.cb_too_large',
  paused: 'phrases.resume_sync_first',
  not_ready: 'product.cb_runtime_failed',
};

/** The queued toast states the real cause (offline versus server busy, rate limited, key, paused). */
const QUEUED_KEY: Record<QueueReason, string> = {
  offline: 'phrases.encrypted_and_queued_will_send_when_online',
  busy: 'product.cb_queued_busy',
  rate_limited: 'product.cb_queued_rate_limited',
  key: 'product.cb_queued_key',
  paused: 'product.cb_queued_paused',
  pending: 'product.cb_queued',
};

/** The paste fallback: why the clipboard could not be read (or `pending` while the browser shows its own Paste UI). */
type Fallback = { reason: ReadFailure | 'pending' };

/**
 * CB-4 Clipboard home and CB-5 item detail (design screen `clipboard`): Sync Clipboard (reads in the click), the
 * capture status panel, the timeline decrypted on this device (newest first; queued, new and locked rows), search and
 * filters, Copy, clear history, and the item drawer at `/clipboard/:eventId`. Loaded only for a ready account.
 */
export default function ClipboardHome({ runtime }: { runtime: ClipboardRuntime }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { device } = useIdentity();
  const state = useClipboardState(runtime);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sensitive, setSensitive] = useState<string | null>(null);
  const [fallback, setFallback] = useState<Fallback | null>(null);
  const [pasted, setPasted] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingPause, setSavingPause] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const readSeq = useRef(0);

  const match = useMatch('/clipboard/:eventId');
  const selectedId = match?.params.eventId;
  const snapshot = state?.snapshot;
  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const selected = selectedId ? items.find((i) => i.id === selectedId) : undefined;
  const copyFailed = (location.state as { copyFailed?: boolean } | null)?.copyFailed === true;
  const settings = snapshot?.settings ?? null;
  const paused = settings?.paused === true;

  const originName = useCallback(
    (origin: string) =>
      origin === device?.id
        ? t('product.cb_this_browser')
        : (state?.deviceNames[origin] ?? t('product.cb_other_device')),
    [device?.id, state?.deviceNames, t],
  );

  // A link to an item that is gone (deleted, expired, cleared) falls back to the list once the timeline is loaded.
  useEffect(() => {
    if (selectedId && snapshot?.loaded && !snapshot.syncing && !selected) navigate('/clipboard', { replace: true });
  }, [selectedId, snapshot?.loaded, snapshot?.syncing, selected, navigate]);

  useEffect(() => {
    if (fallback) pasteRef.current?.focus();
  }, [fallback]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (filter === 'mine' && i.origin !== device?.id) return false;
      if (filter === 'others' && i.origin === device?.id) return false;
      if (filter === 'links' && !isLink(i.text)) return false;
      if (!q) return true;
      return (i.text ?? '').toLowerCase().includes(q) || originName(i.origin).toLowerCase().includes(q);
    });
  }, [items, query, filter, device?.id, originName]);

  const report = useCallback(
    (r: CaptureResult, text: string) => {
      switch (r.kind) {
        case 'synced':
          toast.show(t('phrases.clipboard_synced_encrypted'));
          return true;
        case 'queued':
          toast.show(t(QUEUED_KEY[r.reason]));
          return true;
        case 'sensitive':
          setSensitive(text);
          return true;
        case 'removed':
          // Deleted or cleared here before the server acknowledged it: the user's own action, nothing to report.
          return true;
        default:
          setNotice(r.kind);
          return false;
      }
    },
    [toast, t],
  );

  const capture = async (text: string, force = false) => {
    setNotice(null);
    setSensitive(null);
    return report(await runtime.capture(text, 'manual', force), text);
  };

  // Sync Clipboard: readText() runs inside the click (user gesture). If the browser refuses or shows its own Paste
  // button for a while, the paste fallback opens; the browser is never asked again until the next click.
  const onSync = () => {
    if (paused) {
      setNotice('paused');
      return;
    }
    const seq = ++readSeq.current;
    setNotice(null);
    setSensitive(null);
    setReading(true);
    const read = runtime.readForSync();
    const slow = setTimeout(() => {
      if (seq === readSeq.current) setFallback({ reason: 'pending' });
    }, 4000);
    void read.then(async (r) => {
      clearTimeout(slow);
      if (seq !== readSeq.current) return;
      setReading(false);
      if (!r.ok) {
        if (r.reason === 'empty') {
          setFallback(null);
          setNotice('empty');
        } else setFallback({ reason: r.reason });
        return;
      }
      setFallback(null);
      await capture(r.text);
    });
  };

  const onPasteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pasted.trim()) {
      setNotice('empty');
      return;
    }
    if (await capture(pasted)) {
      setPasted('');
      setFallback(null);
    }
  };

  const copyItem = async (item: ClipItem) => {
    const ok = await runtime.copy(item.id);
    if (ok) {
      setCopiedId(item.id);
      toast.show(t('common.n_copied'));
      setTimeout(() => setCopiedId((c) => (c === item.id ? null : c)), 2000);
    }
    return ok;
  };

  const setPause = async (next: boolean) => {
    if (!settings) return;
    setSavingPause(true);
    try {
      await runtime.engine.saveSettings({ ...settings, paused: next });
    } catch {
      toast.show(t('product.cb_settings_failed'));
    } finally {
      setSavingPause(false);
    }
  };

  const closeDetail = () => {
    navigate('/clipboard', { state: KEEP_FOCUS });
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) searchRef.current?.focus();
    });
  };

  if (!state || !snapshot) return null;
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: t('common.f_all') },
    { value: 'mine', label: t('product.cb_f_mine') },
    { value: 'others', label: t('product.cb_f_others') },
    { value: 'links', label: t('common.f_links') },
  ];
  const days = settings?.retention_days ?? 7;

  return (
    <Screen id="clipboard">
      <PageHeader
        title={t('web.cb_h')}
        subtitle={
          <span className="inline-flex items-center gap-[6px] text-caption font-semibold text-receive-ink">
            <LockKeyhole aria-hidden size={14} />
            {t('web.e2e')} · {t('product.cb_text_only')}
          </span>
        }
        actions={
          <Button
            variant="danger-ghost"
            size="sm"
            icon={Trash2}
            disabled={items.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            {t('common.cb_clear')}
          </Button>
        }
      />

      <section className="grid items-center gap-[20px] rounded-xl border border-border bg-surface p-[clamp(18px,3vw,24px)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
        <div className="flex flex-col gap-[10px]">
          <button
            type="button"
            onClick={onSync}
            aria-busy={reading || undefined}
            data-testid="cb-sync"
            className="flex h-[60px] items-center justify-center gap-[10px] rounded-lg bg-send text-[17px] font-bold text-on-send hover:bg-send-hover"
          >
            <RefreshCw aria-hidden size={20} className={reading ? 'animate-spin' : ''} />
            {reading ? t('product.cb_reading') : t('web.sync')}
          </button>
          <span className="text-center text-caption text-fg-2">{t('product.cb_sync_p')}</span>
        </div>
        <CaptureStatusPanel
          status={state.status}
          autoCapture={state.autoCapture}
          queued={snapshot.queued}
          busy={savingPause || !settings}
          onAutoCapture={setAutoCapture}
          onPause={setPause}
        />
      </section>

      <div role="status" data-testid="cb-sync-result" className="empty:hidden">
        {notice && <p className="m-0 text-[14px] text-fg-2">{t(NOTICE_KEY[notice])}</p>}
      </div>

      {sensitive !== null && (
        <Banner
          tone="warning"
          role="alert"
          title={t('product.cb_sensitive_h')}
          action={
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void capture(sensitive, true)}>
                {t('product.cb_sync_anyway')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSensitive(null)}>
                {t('product.cb_dont_sync')}
              </Button>
            </span>
          }
        >
          <span data-testid="cb-sensitive">{t('product.cb_sensitive_p')}</span>
        </Banner>
      )}

      {fallback && (
        <form
          onSubmit={onPasteSubmit}
          data-testid="cb-paste"
          className="flex flex-col gap-3 rounded-xl border border-border-strong bg-surface p-[clamp(16px,3vw,20px)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="m-0 text-[16px]">
                {fallback.reason === 'denied' ? t('phrases.clipboard_permission_denied') : t('product.cb_paste_h')}
              </h2>
              <p className="mb-0 mt-1 text-[14px] leading-[1.5] text-fg-2">
                {fallback.reason === 'pending'
                  ? t('product.cb_paste_wait_p')
                  : fallback.reason === 'denied'
                    ? t('phrases.allow_clipboard_access_in_your_browser_s_site_settings_lock_')
                    : t('product.cb_paste_p')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                readSeq.current++;
                setReading(false);
                setFallback(null);
              }}
              aria-label={t('common.close')}
              className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-md text-fg-2 hover:bg-surface-2"
            >
              <X aria-hidden size={18} />
            </button>
          </div>
          <textarea
            ref={pasteRef}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            aria-label={t('product.cb_paste_label')}
            rows={3}
            className="min-h-[88px] w-full resize-y rounded-md border border-border-strong bg-surface p-3 text-[14px] text-fg"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="send" disabled={!pasted.trim()}>
              {t('product.cb_paste_send')}
            </Button>
          </div>
        </form>
      )}

      {snapshot.loadError === 'error' && items.length > 0 && (
        <Banner
          tone="danger"
          role="alert"
          action={
            <Button size="sm" icon={RefreshCw} onClick={() => void runtime.engine.refresh()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('product.cb_load_failed')}
        </Banner>
      )}
      {snapshot.loadError === 'offline' && items.length > 0 && (
        <Banner tone="offline">{t('product.cb_offline_cached')}</Banner>
      )}
      {snapshot.settingsError && (
        <Banner
          tone="danger"
          action={
            <Button size="sm" icon={RefreshCw} onClick={() => void runtime.engine.loadSettings()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('product.cb_settings_load_failed')}
        </Banner>
      )}
      {snapshot.sendError === 'key' && (
        <Banner
          tone="danger"
          role="alert"
          action={
            <Link to="/account/key/pair?returnTo=%2Fclipboard" className="whitespace-nowrap font-semibold">
              {t('product.pair_again')}
            </Link>
          }
        >
          {t('product.cb_send_key')}
        </Banner>
      )}
      {snapshot.sendError === 'rate_limited' && <Banner tone="warning">{t('product.cb_rate_limited')}</Banner>}
      {snapshot.sendError === 'rejected' && <Banner tone="danger">{t('product.cb_too_large')}</Banner>}
      {snapshot.sendError === 'error' && (
        <Banner
          tone="danger"
          action={
            <Button size="sm" icon={RefreshCw} onClick={() => void runtime.engine.flush()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('product.cb_send_failed')}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-[10px]">
        <label className="flex h-[44px] min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-fg-3">
          <Search aria-hidden size={16} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('web.cb_search')}
            aria-label={t('web.cb_search')}
            className="h-full flex-1 border-0 bg-transparent text-[14px] text-fg outline-none"
          />
        </label>
        <div role="group" aria-label={t('product.cb_filter')} className="flex flex-wrap gap-[6px]">
          {filters.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={`h-[36px] min-h-touch rounded-full border px-3 text-caption font-semibold rail:min-h-0 ${filter === f.value ? 'border-fg bg-fg text-bg' : 'border-border-strong bg-surface text-fg-2'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {snapshot.skipped.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t('product.cb_sensitive_h')}>
          {snapshot.skipped.map((s) => (
            <li
              key={s.id}
              data-testid="cb-skipped"
              className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-[14px] italic text-fg-2"
            >
              <EyeOff aria-hidden size={16} className="flex-none" />
              <span className="flex-1">
                {t('product.cb_skipped_row')} <span className="not-italic">· {formatWhen(s.at, locale)}</span>
              </span>
              <button
                type="button"
                onClick={() => runtime.engine.dismissSkipped(s.id)}
                aria-label={t('product.cb_dismiss')}
                className="flex h-[36px] min-h-touch w-[36px] min-w-touch flex-none items-center justify-center rounded-md not-italic hover:bg-surface-2 rail:min-h-0 rail:min-w-0"
              >
                <X aria-hidden size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!snapshot.loaded || (items.length === 0 && !snapshot.synced && !snapshot.loadError) ? (
        // Still reading the cache, or (nothing cached) the first refresh is running: not "empty" yet.
        <div role="status" aria-busy="true" className="flex flex-col gap-[10px]">
          <span className="sr-only">{t('product.cb_loading')}</span>
          <div aria-hidden className="h-[72px] animate-pulse rounded-lg bg-surface-2" />
          <div aria-hidden className="h-[72px] animate-pulse rounded-lg bg-surface-2" />
        </div>
      ) : items.length === 0 && snapshot.loadError === 'offline' ? (
        // First load while offline with nothing cached: the timeline is unknown, not empty.
        <div
          role="status"
          data-testid="cb-offline"
          className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-surface px-[20px] py-[40px] text-center"
        >
          <span
            aria-hidden
            className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-warning-soft text-warning-ink"
          >
            <WifiOff size={22} />
          </span>
          <b>{t('common.off_h')}</b>
          <span className="max-w-[380px] text-[14px] leading-[1.5] text-fg-2">{t('product.cb_offline_empty_p')}</span>
        </div>
      ) : items.length === 0 && snapshot.loadError === 'error' ? (
        <div
          role="alert"
          data-testid="cb-load-error"
          className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-surface px-[20px] py-[40px] text-center"
        >
          <span
            aria-hidden
            className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-danger-soft text-danger-ink"
          >
            <CircleAlert size={22} />
          </span>
          <b>{t('product.cb_load_failed')}</b>
          <Button
            size="sm"
            icon={RefreshCw}
            disabled={snapshot.syncing}
            onClick={() => void runtime.engine.refresh()}
            className="mt-2"
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div
          data-testid="cb-empty"
          className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-surface px-[20px] py-[40px] text-center"
        >
          <span
            aria-hidden
            className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-surface-2 text-fg-2"
          >
            <Clipboard size={22} />
          </span>
          <b>{t('common.cb_empty_h')}</b>
          <span className="max-w-[380px] text-[14px] leading-[1.5] text-fg-2">{t('common.cb_empty_p')}</span>
        </div>
      ) : shown.length === 0 ? (
        <p className="m-0 p-6 text-center text-[14px] text-fg-2">{t('common.nomatch')}</p>
      ) : (
        <>
          <ol className="m-0 flex list-none flex-col gap-[10px] p-0" data-testid="cb-list">
            {shown.map((i) => (
              <li
                key={i.id}
                data-testid="cb-item"
                className={`flex items-start gap-[14px] rounded-lg border px-4 py-[14px] ${i.incoming ? 'border-send bg-send-soft' : 'border-border bg-surface'}`}
              >
                <span
                  aria-hidden
                  className="flex h-[36px] w-[36px] flex-none items-center justify-center rounded-md bg-surface-2 text-fg-2"
                >
                  <Globe size={17} />
                </span>
                <Link
                  to={`/clipboard/${encodeURIComponent(i.id)}`}
                  state={KEEP_FOCUS}
                  className="flex min-w-0 flex-1 flex-col gap-1 text-fg no-underline hover:text-fg"
                >
                  <span className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
                    <b className="text-fg">{originName(i.origin)}</b>· {formatWhen(i.createdAt, locale)}
                    {i.incoming && <span className="font-bold text-send-ink">{t('product.cb_new')}</span>}
                    {i.pending && (
                      <span className="inline-flex items-center gap-1 font-semibold text-warning-ink">
                        <Clock aria-hidden size={12} />
                        {t('common.queued')}
                      </span>
                    )}
                  </span>
                  {i.text === null ? (
                    <span className="flex items-center gap-[6px] text-[14px] italic text-fg-2">
                      <Lock aria-hidden size={14} />
                      {t('product.cb_locked')}
                    </span>
                  ) : (
                    <span className="line-clamp-2 break-words text-[14px] leading-[1.5]" data-testid="cb-item-text">
                      {i.text}
                    </span>
                  )}
                </Link>
                {i.text !== null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={copiedId === i.id ? Check : Copy}
                    aria-label={`${t('web.copy')}: ${i.text.slice(0, 40)}`}
                    onClick={async () => {
                      if (!(await copyItem(i)))
                        navigate(`/clipboard/${encodeURIComponent(i.id)}`, { state: { copyFailed: true } });
                    }}
                  >
                    {copiedId === i.id ? t('web.copied') : t('web.copy')}
                  </Button>
                )}
              </li>
            ))}
          </ol>
          <p className="m-0 text-center text-[12px] text-fg-3">
            {days === 1 ? t('product.cb_keep_note_1') : t('product.cb_keep_note', { n: days })} ·{' '}
            <Link to="/settings/clipboard">{t('product.cb_settings_link')}</Link>
          </p>
        </>
      )}

      {selected && (
        <ClipboardDetail
          key={selected.id}
          item={selected}
          origin={originName(selected.origin)}
          copyFailed={copyFailed}
          busy={deleting}
          onClose={closeDetail}
          onCopy={() => copyItem(selected)}
          onDelete={async () => {
            setDeleting(true);
            try {
              await runtime.engine.remove(selected.id);
              navigate('/clipboard', { replace: true, state: KEEP_FOCUS });
              toast.show(t('common.n_del'));
            } catch {
              toast.show(t('product.cb_delete_failed'));
            } finally {
              setDeleting(false);
            }
          }}
        />
      )}

      <ConfirmDialog
        open={confirmClear}
        title={t('common.cbc_h')}
        body={t('common.cbc_p')}
        confirmLabel={t('common.cb_clear')}
        cancelLabel={t('common.cancel')}
        danger
        busy={clearing}
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          setClearing(true);
          try {
            await runtime.engine.clear();
            toast.show(t('common.n_cbcleared'));
          } catch {
            toast.show(t('product.cb_clear_failed'));
          } finally {
            setClearing(false);
            setConfirmClear(false);
          }
        }}
      />
    </Screen>
  );
}
