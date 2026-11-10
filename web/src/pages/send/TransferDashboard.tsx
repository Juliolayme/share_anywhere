import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Ban,
  Pause,
  Play,
  RefreshCw,
  Square,
  UserX,
  Laptop,
  Smartphone,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button, Card, ConfirmDialog, Screen } from '../../components/ui';
import { KeepOpenBanner } from '../../components/KeepOpenBanner';
import { useI18n } from '../../i18n/i18n';
import { formatBytes } from '../../lib/format';
import { useKeepAwake } from '../../lib/keepAwake/KeepAwakeContext';
import { useSharing } from '../../features/sharing/SharingContext';
import { useSender } from '../../features/transfer/TransferContext';
import {
  txActive,
  type TxFinal,
  type TxReceiver,
  type TxStatus,
} from '../../features/transfer/runtime/sender-controller';
import {
  ConnectionLog,
  ProgressBar,
  RouteChip,
  TransferChip,
  percent,
  useEta,
  useSpeed,
  type ChipState,
} from '../../features/transfer/ui';

const FINAL: Record<Exclude<TxFinal, null>, { title: string; body: string; cls: string; icon: typeof CircleCheck }> = {
  completed: {
    title: 'product.fin_completed_h',
    body: 'product.fin_completed_p',
    cls: 'bg-receive-soft text-receive-ink',
    icon: CircleCheck,
  },
  partial: {
    title: 'product.fin_partial_h',
    body: 'product.fin_partial_p',
    cls: 'bg-warning-soft text-warning-ink',
    icon: CircleDashed,
  },
  failed: {
    title: 'product.fin_failed_h',
    body: 'product.fin_failed_p',
    cls: 'bg-danger-soft text-danger-ink',
    icon: CircleX,
  },
  cancelled: {
    title: 'product.fin_cancelled_h',
    body: 'product.fin_cancelled_p',
    cls: 'bg-surface-2 text-fg-2',
    icon: Ban,
  },
};

const ORDER: TxStatus[] = [
  'transferring',
  'connecting',
  'reconnecting',
  'verifying',
  'paused',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'removed',
];
const mobile = (platform: string) => /android|iphone|ipad|ios|mobile/i.test(platform);

/** TR-6 Transfer dashboard (`dashboard`) and TR-7 Session result (`dashboard-done`, `dashboard-partial`). */
export default function TransferDashboard() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { api } = useSharing();
  const [tx, s, failed] = useSender(id);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const active = s.receivers.some((r) => txActive(r.status));
  const pill = useKeepAwake(active);

  useEffect(() => {
    if (s.final && location.pathname.endsWith('/transfers')) navigate(`/send/session/${id}/result`, { replace: true });
  }, [s.final, location.pathname, navigate, id]);

  const total = s.files.reduce((a, f) => a + f.size, 0);
  const count = s.files.length === 1 ? t('product.files_count_one') : t('product.files_count', { n: s.files.length });
  const n = s.receivers.length;
  const overallDone = s.receivers.reduce((a, r) => a + r.verified, 0);
  const overallTotal = n * total;
  const counts = ORDER.map((st) => ({ st, n: s.receivers.filter((r) => r.status === st).length })).filter(
    (c) => c.n > 0,
  );
  const screen = s.final ? (s.final === 'completed' ? 'dashboard-done' : 'dashboard-partial') : 'dashboard';

  const close = async () => {
    setClosing(true);
    tx.cancelAll();
    try {
      await api.close(id);
    } finally {
      setClosing(false);
      setConfirmClose(false);
      navigate(`/send/session/${id}`);
    }
  };

  return (
    <Screen id={screen}>
      {!s.final && <KeepOpenBanner state={pill} />}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-[6px]">
            <span className="text-[13px] font-semibold text-fg-2">
              {t('product.dash_sub', { count, size: formatBytes(total, locale) })}
            </span>
            <h1 className="m-0 text-[clamp(24px,3vw,30px)] tracking-[-0.025em]">
              {n === 1 ? t('product.dash_h_one') : t('web.dash_h', { n })}
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            {!s.final && n > 0 && (
              <Button variant="danger-ghost" icon={Square} onClick={() => setConfirmStop(true)}>
                {t('web.stopall')}
              </Button>
            )}
            <Button onClick={() => setConfirmClose(true)}>{t('web.close')}</Button>
          </div>
        </div>
        {failed && <Banner tone="danger" role="alert" title={t('product.error_generic')} />}
        {!s.hasFiles && s.loaded && !s.final && <Banner tone="warning" role="alert" title={t('product.tx_no_files')} />}
        {s.final && <FinalBanner final={s.final} />}
        <Card className="flex flex-col gap-3 px-[20px] py-[18px]" as="section">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="flex items-baseline gap-[10px]">
              <b className="text-[28px] tracking-[-0.02em]" data-testid="overall-percent">
                {percent(overallDone, overallTotal)}
              </b>
              <span className="text-[14px] text-fg-2">{t('web.overall')}</span>
            </span>
            <span className="font-mono text-[13px] text-fg-2">
              {t('product.bytes_of', {
                done: formatBytes(overallDone, locale),
                total: formatBytes(overallTotal, locale),
              })}
            </span>
          </div>
          <ProgressBar value={overallTotal ? overallDone / overallTotal : 0} label={t('web.overall')} height={10} />
          <div className="flex flex-wrap gap-[6px]">
            {counts.map((c) => (
              <span key={c.st} className="inline-flex items-center gap-1 text-[12px] font-semibold">
                <span className="font-mono">{c.n}</span>
                <TransferChip state={c.st as ChipState} />
              </span>
            ))}
          </div>
        </Card>
        {s.receivers.some((r) => r.status === 'reconnecting') && (
          <div
            role="status"
            className="flex items-center gap-[10px] rounded-[12px] bg-warning-soft px-4 py-3 text-[14px] text-warning-ink"
          >
            <RefreshCw aria-hidden size={16} className="animate-spin motion-reduce:animate-none" />
            <span className="flex-1">{t('product.reconnecting')}</span>
          </div>
        )}
        {n === 0 ? (
          <Card className="flex flex-col items-center gap-3 p-6 text-center" as="section">
            <b>{t('web.waiting_r')}</b>
            <Link to={`/send/session/${id}`} className="font-semibold">
              {t('product.back_to_session')}
            </Link>
          </Card>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-4">
            {s.receivers.map((r) => (
              <ReceiverCard
                key={r.participantId}
                r={r}
                onPause={() => tx.pause(r.participantId)}
                onResume={() => tx.resume(r.participantId)}
                onRemove={() => void api.remove(r.participantId)}
              />
            ))}
          </div>
        )}
        {n > 0 && (
          <Card className="overflow-auto" as="section">
            <div className="border-b border-border px-[18px] py-[14px]">
              <h2 className="m-0 text-[16px]">{t('web.matrix')}</h2>
            </div>
            <table className="w-full min-w-[480px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border text-[12px] text-fg-2">
                  <th scope="col" className="px-[18px] py-[10px] font-semibold">
                    {t('product.matrix_file')}
                  </th>
                  {s.receivers.map((r) => (
                    <th
                      key={r.participantId}
                      scope="col"
                      className="max-w-[160px] truncate px-3 py-[10px] font-semibold"
                    >
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.files.map((f) => (
                  <tr key={f.fileId} className="border-b border-border last:border-b-0">
                    <th scope="row" className="px-[18px] py-3 text-left font-normal">
                      <span className="block truncate text-[13px] font-semibold">{f.name}</span>
                      <span className="font-mono text-[11px] text-fg-2">{formatBytes(f.size, locale)}</span>
                    </th>
                    {s.receivers.map((r) => {
                      const done = (r.perFile[f.index] ?? 0) >= f.size && (r.status === 'completed' || f.size === 0);
                      const v = r.perFile[f.index] ?? 0;
                      return (
                        <td key={r.participantId} className="px-3 py-3">
                          <span className="flex flex-col gap-1">
                            {done ? (
                              <span className="flex items-center gap-1 text-[12px] font-semibold text-receive-ink">
                                <CircleCheck aria-hidden size={14} />
                                {t('common.done')}
                              </span>
                            ) : v === 0 ? (
                              <span className="text-[12px] text-fg-3">{t('common.queued')}</span>
                            ) : (
                              <span className="font-mono text-[12px] text-fg-2">{percent(v, f.size)}</span>
                            )}
                            <ProgressBar
                              value={f.size ? v / f.size : 1}
                              label={`${f.name} · ${r.name}`}
                              height={4}
                              tone={done ? 'receive' : 'send'}
                            />
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      <ConfirmDialog
        open={confirmStop}
        title={t('product.stopall_h')}
        body={t('product.stopall_p')}
        confirmLabel={t('web.stopall')}
        cancelLabel={t('web.cancel')}
        danger
        onConfirm={() => {
          setConfirmStop(false);
          tx.cancelAll();
        }}
        onCancel={() => setConfirmStop(false)}
      />
      <ConfirmDialog
        open={confirmClose}
        title={t('product.close_h')}
        body={t('product.close_p')}
        confirmLabel={t('web.close')}
        cancelLabel={t('web.cancel')}
        danger
        busy={closing}
        onConfirm={() => void close()}
        onCancel={() => setConfirmClose(false)}
      />
    </Screen>
  );
}

function FinalBanner({ final }: { final: Exclude<TxFinal, null> }) {
  const { t } = useI18n();
  const f = FINAL[final];
  const Icon = f.icon;
  return (
    <div
      role="status"
      data-testid="final-banner"
      data-final={final}
      className={`flex flex-wrap items-center gap-4 rounded-[16px] px-[20px] py-[18px] ${f.cls}`}
    >
      <span aria-hidden className="flex h-[48px] w-[48px] items-center justify-center rounded-full bg-surface">
        <Icon size={26} />
      </span>
      <div className="min-w-[200px] flex-1">
        <b className="text-[16px]">{t(f.title)}</b>
        <div className="mt-[2px] text-[14px] text-fg">{t(f.body)}</div>
      </div>
      <Link
        to="/history"
        className="inline-flex h-[42px] items-center rounded-[10px] border border-border-strong bg-surface px-[14px] text-[14px] font-semibold text-fg no-underline"
      >
        {t('product.view_history')}
      </Link>
      <Link
        to="/send"
        className="inline-flex h-[42px] items-center rounded-[10px] bg-send px-[14px] text-[14px] font-semibold text-on-send no-underline"
      >
        {t('product.new_transfer')}
      </Link>
    </div>
  );
}

function ReceiverCard({
  r,
  onPause,
  onResume,
  onRemove,
}: {
  r: TxReceiver;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const eta = useEta();
  const speed = useSpeed();
  const [details, setDetails] = useState(false);
  const Icon = mobile(r.platform) ? Smartphone : Laptop;
  const ended = ['completed', 'failed', 'cancelled', 'removed'].includes(r.status);
  return (
    <article
      aria-label={r.name}
      data-testid="receiver-card"
      data-status={r.status}
      className={`flex flex-col gap-[14px] rounded-[16px] border border-border bg-surface p-[18px] ${r.status === 'removed' || r.status === 'cancelled' ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-[44px] w-[44px] flex-none items-center justify-center rounded-[12px] bg-surface-2"
        >
          <Icon size={21} />
        </span>
        <div className="min-w-0 flex-1">
          <b className="text-[15px]">{r.name}</b>
          <div className="truncate text-[12px] text-fg-2">{r.platform}</div>
        </div>
        <TransferChip state={r.status as ChipState} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RouteChip route={r.route} />
        {!ended && <span className="font-mono text-[12px] text-fg-2">{speed(r.bytesPerSecond)}</span>}
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className="flex justify-between gap-2 text-[13px]">
          <b>{percent(r.verified, r.total)}</b>
          {!ended && (
            <span className="text-fg-2">
              {r.status === 'waiting'
                ? t('product.transfer_waiting')
                : r.status === 'paused'
                  ? t('web.st.paused')
                  : eta(r.eta)}
            </span>
          )}
        </div>
        <ProgressBar
          value={r.total ? r.verified / r.total : 1}
          label={r.name}
          tone={
            r.status === 'completed'
              ? 'receive'
              : r.status === 'failed'
                ? 'danger'
                : r.status === 'reconnecting'
                  ? 'warning'
                  : 'send'
          }
        />
        <span className="font-mono text-[12px] text-fg-2">
          {t('product.bytes_of', { done: formatBytes(r.verified, locale), total: formatBytes(r.total, locale) })}
        </span>
      </div>
      {r.error && (
        <p className="m-0 rounded-[10px] bg-danger-soft px-3 py-[10px] text-[13px] text-danger-ink">{t(r.error)}</p>
      )}
      <div className="flex flex-wrap gap-[6px]">
        {txActive(r.status) && (
          <Button size="sm" icon={Pause} onClick={onPause} aria-label={`${t('web.pause')} ${r.name}`}>
            {t('web.pause')}
          </Button>
        )}
        {r.status === 'paused' && (
          <Button size="sm" variant="send" icon={Play} onClick={onResume} aria-label={`${t('web.resume')} ${r.name}`}>
            {t('web.resume')}
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
          {t('web.details')}
        </Button>
        <span className="flex-1" />
        {!ended && (
          <Button
            size="sm"
            variant="ghost"
            icon={UserX}
            onClick={onRemove}
            aria-label={t('product.remove_confirm', { name: r.name })}
          >
            {t('web.remove')}
          </Button>
        )}
      </div>
      {details && <ConnectionLog lines={r.log} />}
    </article>
  );
}
