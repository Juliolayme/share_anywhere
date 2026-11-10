import { HardDrive, History as HistoryIcon, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Banner, Button, Card, ConfirmDialog, PageHeader, Screen } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n/i18n';
import { useHistory } from '../features/history/HistoryContext';
import { HistoryRow } from '../features/history/HistoryRow';
import { filterHistory, type HistoryFilter } from '../features/history/store/history-store';

const selectCls = 'h-[42px] rounded-md border border-border-strong bg-surface px-[10px] text-[14px] text-fg';

/** HI-1 / design screen `history`: local-only history with tabs, search and filters. */
export default function HistoryPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { entries, loading, error, clear } = useHistory();
  const [filter, setFilter] = useState<HistoryFilter>({ tab: 'all', query: '', status: 'any', range: 'all', peer: '' });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const peers = useMemo(() => [...new Set(entries.map((e) => e.peer))].sort(), [entries]);
  const shown = useMemo(() => filterHistory(entries, filter), [entries, filter]);
  const set = (p: Partial<HistoryFilter>) => setFilter((f) => ({ ...f, ...p }));

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
            <HardDrive aria-hidden size={14} />
            {t('common.local')} · {t('web.guest')}
          </span>
        }
        actions={
          <Button variant="danger-ghost" icon={Trash2} disabled={entries.length === 0} onClick={() => setConfirm(true)}>
            {t('web.clear')}
          </Button>
        }
      />
      {error && <Banner tone="danger" role="alert" title={t('product.history_unavailable')} />}
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
                const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = tabs[(i + step + tabs.length) % tabs.length];
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
            value={filter.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder={t('common.h_search')}
            aria-label={t('common.h_search')}
            className="h-full flex-1 border-0 bg-transparent text-[14px] text-fg outline-none"
          />
        </label>
        <select
          aria-label={t('web_vv.k98')}
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
          aria-label={t('web_vv.k103')}
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
          aria-label={t('web_vv.k106')}
          value={filter.peer}
          onChange={(e) => set({ peer: e.target.value })}
          className={selectCls}
        >
          <option value="">{t('web_vv.k106')}</option>
          {peers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div id="history-panel" role="tabpanel" aria-labelledby={`history-tab-${filter.tab}`}>
        {loading ? (
          <div aria-hidden className="h-[120px] animate-pulse rounded-[16px] bg-surface-2" />
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-surface px-[20px] py-[40px] text-center">
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
                <HistoryRow key={h.id} entry={h} />
              ))}
            </ul>
          </Card>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title={t('common.hc_h')}
        body={t('common.hc_p')}
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
            toast.show(t('product.history_unavailable'));
          } finally {
            setBusy(false);
            setConfirm(false);
          }
        }}
      />
    </Screen>
  );
}
