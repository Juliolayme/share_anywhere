import { Cloud, HardDrive, History as HistoryIcon, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router-dom';
import { Banner, Button, Card, ConfirmDialog, PageHeader, Screen } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n/i18n';
import { useHistory } from '../features/history/HistoryContext';
import { HistoryDetail } from '../features/history/HistoryDetail';
import { HistoryRow, historyPath } from '../features/history/HistoryRow';
import { EMPTY_FILTER, filterHistory, historyPeers, type HistoryFilter } from '../features/history/store/history-store';
import { useAccount } from '../features/account/AccountContext';
import { formatWhen } from '../lib/format';

/**
 * HI-1 account banner (docs/UX_SCREEN_MAP.md HI-1): Sign in to sync for guests, add this device, pair this device,
 * Turn on history sync, or the sync status with errors stated plainly.
 */
function SyncBanner() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  if (!account.enabled) return null;
  const link = 'whitespace-nowrap font-semibold';
  if (account.phase === 'guest') {
    return (
      <Banner
        tone="info"
        action={
          <Link to="/signin?returnTo=%2Fhistory" className={link} data-testid="history-signin">
            {t('web.signin')}
          </Link>
        }
      >
        {t('product.history_signin')}
      </Banner>
    );
  }
  if (!account.added) {
    return (
      <Banner
        tone="info"
        action={
          <Link to="/signin/choices?returnTo=%2Fhistory" className={link}>
            {t('product.add_device_btn')}
          </Link>
        }
      >
        {t('product.not_added_p')}
      </Banner>
    );
  }
  if (!account.me) return null;
  if (!account.me.history_sync) {
    return (
      <Banner
        tone="info"
        action={
          <Button
            size="sm"
            variant="send"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await account.setHistorySync(true);
              } catch {
                toast.show(t('product.history_sync_failed_toggle'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('product.turn_on_history_sync')}
          </Button>
        }
      >
        {t('common.local')}
      </Banner>
    );
  }
  if (account.keys === 'pair' || account.keys === 'setup') {
    return (
      <Banner
        tone="warning"
        action={
          <Link to="/account/key/pair?returnTo=%2Fhistory" className={link}>
            {t('product.pair_h')}
          </Link>
        }
      >
        {t('product.history_pair')}
      </Banner>
    );
  }
  if (account.keys === 'unavailable') return <Banner tone="danger" title={t('product.keys_unavailable')} />;
  const s = account.sync;
  if (s.state === 'error') {
    return (
      <Banner
        tone={s.offline ? 'offline' : 'danger'}
        role="alert"
        action={
          <Button size="sm" icon={RefreshCw} onClick={() => void account.syncNow()}>
            {t('common.retry')}
          </Button>
        }
      >
        {s.offline ? t('product.history_sync_offline') : t('product.history_sync_failed')}
      </Banner>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-caption text-fg-2" role="status" data-testid="sync-status">
      <Cloud aria-hidden size={14} />
      {s.state === 'running' || s.state === 'idle'
        ? t('product.history_syncing')
        : t('product.history_synced_at', { when: formatWhen(s.at, locale) })}
      {s.state === 'ok' && s.unreadable > 0 && (
        <span className="text-warning-ink">{t('product.history_unreadable', { n: s.unreadable })}</span>
      )}
      {s.state === 'ok' && (
        <Button variant="link" onClick={() => void account.syncNow()}>
          {t('product.history_sync_now')}
        </Button>
      )}
    </div>
  );
}

/** History list ↔ drawer navigations keep focus where the drawer puts it (see AppShell). */
const KEEP_FOCUS = { keepFocus: true };

const selectCls = 'h-[42px] rounded-md border border-border-strong bg-surface px-[10px] text-[14px] text-fg';

/**
 * HI-1 / HI-2, design screen `history`: local-only history with tabs, search and filters (date, device, status),
 * and the entry detail drawer at `/history/:entryId` with Delete from history. Opening the page refreshes the list
 * and applies the retention sweep from Settings.
 */
export default function HistoryPage() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { entries, loading, error, clear, remove, refresh } = useHistory();
  const account = useAccount();
  const syncing = account.added && account.me?.history_sync === true;
  const { syncNow } = account;
  const [filter, setFilter] = useState<HistoryFilter>(EMPTY_FILTER);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const peers = useMemo(() => historyPeers(entries), [entries]);
  const shown = useMemo(() => filterHistory(entries, filter), [entries, filter]);
  const set = (p: Partial<HistoryFilter>) => setFilter((f) => ({ ...f, ...p }));

  const match = useMatch('/history/:entryId');
  const selectedId = match?.params.entryId;
  const selected = selectedId ? entries.find((e) => e.id === selectedId) : undefined;

  // Entries written by a transfer since the list was loaded appear, and the retention sweep runs, on every visit.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Opening History also syncs (when the account syncs history on this device).
  useEffect(() => {
    if (syncing) void syncNow();
  }, [syncing, syncNow]);

  // A link to an entry that is gone (deleted, swept, cleared) falls back to the list.
  useEffect(() => {
    if (selectedId && !loading && !selected) navigate('/history', { replace: true });
  }, [selectedId, loading, selected, navigate]);

  // The drawer returns focus to the row that opened it; when that row is gone, focus lands on the search field.
  const focusFallback = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) searchRef.current?.focus();
    });
  }, []);

  const closeDetail = useCallback(() => {
    navigate('/history', { state: KEEP_FOCUS });
    focusFallback();
  }, [navigate, focusFallback]);

  const deleteSelected = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await remove(selected.id);
      navigate('/history', { replace: true, state: KEEP_FOCUS });
      focusFallback();
      toast.show(t('phrases.removed_from_history'));
    } catch {
      toast.show(t(error ? 'product.history_unavailable' : 'product.history_delete_failed'));
    } finally {
      setDeleting(false);
    }
  };

  const tabs: { value: HistoryFilter['tab']; label: string }[] = [
    { value: 'all', label: t('common.f_all') },
    { value: 'sent', label: t('common.f_sent') },
    { value: 'received', label: t('common.f_recv') },
  ];

  return (
    <Screen id="history">
      <PageHeader
        title={t('web.hi_h')}
        subtitle={
          <span className="inline-flex items-center gap-[6px] text-caption">
            {syncing ? <Cloud aria-hidden size={14} /> : <HardDrive aria-hidden size={14} />}
            {syncing
              ? t('product.history_synced_sub')
              : account.phase === 'signed_in'
                ? t('common.local')
                : `${t('common.local')} · ${t('web.guest')}`}
          </span>
        }
        actions={
          <Button variant="danger-ghost" icon={Trash2} disabled={entries.length === 0} onClick={() => setConfirm(true)}>
            {t('web.clear')}
          </Button>
        }
      />
      {error && <Banner tone="danger" role="alert" title={t('product.history_unavailable')} />}
      <SyncBanner />
      <div className="flex flex-wrap items-center gap-[10px]">
        <div role="tablist" aria-label={t('web.hi_h')} className="flex gap-1 rounded-md bg-surface-2 p-1">
          {tabs.map((o, i) => (
            <button
              key={o.value}
              id={`history-tab-${o.value}`}
              type="button"
              role="tab"
              aria-selected={filter.tab === o.value}
              aria-controls="history-panel"
              tabIndex={filter.tab === o.value ? 0 : -1}
              onClick={() => set({ tab: o.value })}
              onKeyDown={(e) => {
                const target =
                  e.key === 'ArrowRight'
                    ? (i + 1) % tabs.length
                    : e.key === 'ArrowLeft'
                      ? (i - 1 + tabs.length) % tabs.length
                      : e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? tabs.length - 1
                          : -1;
                if (target < 0) return;
                e.preventDefault();
                const next = tabs[target];
                if (!next) return;
                set({ tab: next.value });
                document.getElementById(`history-tab-${next.value}`)?.focus();
              }}
              className={`min-h-[34px] rounded-sm px-[14px] text-caption font-semibold ${filter.tab === o.value ? 'bg-surface text-fg shadow-e1' : 'text-fg-2'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="flex h-[42px] min-w-[200px] flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-fg-3">
          <Search aria-hidden size={16} />
          <input
            ref={searchRef}
            type="search"
            value={filter.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder={t('common.h_search')}
            aria-label={t('common.h_search')}
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-[14px] text-fg outline-none"
          />
        </label>
        <select
          aria-label={t('product.filter_status')}
          value={filter.status}
          onChange={(e) => set({ status: e.target.value as HistoryFilter['status'] })}
          className={selectCls}
        >
          <option value="any">{t('web_vv.k98')}</option>
          <option value="completed">{t('web_vv.k99')}</option>
          <option value="partial">{t('web_vv.k100')}</option>
          <option value="failed">{t('web_vv.k101')}</option>
          <option value="cancelled">{t('web_vv.k102')}</option>
        </select>
        <select
          aria-label={t('product.filter_date')}
          value={filter.range}
          onChange={(e) => set({ range: e.target.value as HistoryFilter['range'] })}
          className={selectCls}
        >
          <option value="all">{t('common.f_all')}</option>
          <option value="30d">{t('web_vv.k103')}</option>
          <option value="7d">{t('web_vv.k104')}</option>
          <option value="today">{t('web_vv.k105')}</option>
        </select>
        <select
          aria-label={t('product.filter_device')}
          value={filter.peer}
          onChange={(e) => set({ peer: e.target.value })}
          className={`${selectCls} max-w-full`}
        >
          <option value="">{t('web_vv.k106')}</option>
          {peers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div
        id="history-panel"
        role="tabpanel"
        aria-labelledby={`history-tab-${filter.tab}`}
        aria-busy={loading || undefined}
      >
        <span className="sr-only" aria-live="polite" data-testid="history-count">
          {loading || entries.length === 0
            ? ''
            : shown.length === 1
              ? t('product.history_results_one')
              : t('product.history_results', { n: shown.length })}
        </span>
        {loading ? (
          <div aria-hidden className="h-[120px] animate-pulse rounded-[16px] bg-surface-2" />
        ) : shown.length === 0 ? (
          <div
            data-testid="history-empty"
            className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-surface px-[20px] py-[40px] text-center"
          >
            <span
              aria-hidden
              className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-surface-2 text-fg-2"
            >
              <HistoryIcon size={22} />
            </span>
            <b>{entries.length === 0 ? t('common.empty_h') : t('common.h_empty_h')}</b>
            <span className="max-w-[420px] text-[14px] text-fg-2">
              {entries.length === 0 ? t('common.empty_p') : t('common.h_empty_p')}
            </span>
          </div>
        ) : (
          <Card className="overflow-hidden">
            <ul className="m-0 list-none p-0">
              {shown.map((h) => (
                <HistoryRow key={h.id} entry={h} to={historyPath(h.id)} keepFocus />
              ))}
            </ul>
          </Card>
        )}
      </div>
      {selected && <HistoryDetail entry={selected} busy={deleting} onClose={closeDetail} onDelete={deleteSelected} />}
      <ConfirmDialog
        open={confirm}
        title={t('common.hc_h')}
        body={syncing ? `${t('common.hc_p')} ${t('product.history_clear_synced')}` : t('common.hc_p')}
        confirmLabel={t('web.clear')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await clear();
            toast.show(t('common.n_cleared'));
          } catch {
            toast.show(t(error ? 'product.history_unavailable' : 'product.clear_failed'));
          } finally {
            setBusy(false);
            setConfirm(false);
          }
        }}
      />
    </Screen>
  );
}
