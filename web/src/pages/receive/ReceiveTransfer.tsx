import {
  Check,
  CircleDashed,
  Download,
  FileX,
  Pause,
  Play,
  ShieldCheck,
  WifiOff,
  File as FileIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Banner, Button, Card, ConfirmDialog, Screen } from '../../components/ui';
import { KeepOpenBanner } from '../../components/KeepOpenBanner';
import { useI18n } from '../../i18n/i18n';
import { formatBytes } from '../../lib/format';
import { useKeepAwake } from '../../lib/keepAwake/KeepAwakeContext';
import { SecurityWords } from '../../features/sharing/ParticipantCard';
import { useReceiver } from '../../features/transfer/TransferContext';
import { rxActive, rxFinal, type RxPhase } from '../../features/transfer/runtime/receiver-controller';
import {
  ConnectionLog,
  ProgressBar,
  barTone,
  RouteChip,
  TransferChip,
  percent,
  useEta,
  useSpeed,
  type ChipState,
} from '../../features/transfer/ui';

const CHIP: Partial<Record<RxPhase, ChipState>> = {
  connecting: 'connecting',
  unreachable: 'waiting', // nothing failed: Retry starts a new window
  transferring: 'receiving',
  paused: 'paused',
  reconnecting: 'reconnecting',
  verifying: 'verifying',
};

/** RX-6 Receiving (`receive-progress`) and RX-7 Receive result (`receive-done`) for a JOINED receiver. */
export function ReceiveTransfer({
  sessionId,
  senderName,
  words,
}: {
  sessionId: string;
  senderName: string;
  words?: string[] | undefined;
}) {
  const { t, locale } = useI18n();
  const [rx, s, failed] = useReceiver(sessionId);
  const eta = useEta();
  const speed = useSpeed();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showLog, setShowLog] = useState(false);
  // Keep the screen on while connecting, receiving, reconnecting, or verifying; released on pause and at the end.
  const pill = useKeepAwake(rxActive(s.phase));

  if (s.phase === 'choose' || s.phase === 'permission') return <Navigate to={`/receive/${sessionId}/save`} replace />;
  if (s.phase === 'loading') {
    return (
      <Screen id="receive-progress">
        {failed && (
          <Banner
            tone="danger"
            role="alert"
            title={t('product.error_generic')}
            action={
              <Button size="sm" onClick={() => window.location.reload()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        <div aria-hidden className="mx-auto h-[240px] w-full max-w-[680px] animate-pulse rounded-[16px] bg-surface-2" />
      </Screen>
    );
  }

  const fileList = (final: boolean) => (
    <Card className="overflow-hidden" as="section">
      <ul className="m-0 list-none p-0" aria-label={t('product.files_count', { n: s.files.length })}>
        {s.files.map((f) => (
          <li
            key={f.fileId}
            className="flex flex-wrap items-center gap-3 border-b border-border px-[18px] py-3 last:border-b-0"
          >
            <FileIcon aria-hidden size={19} className="flex-none text-fg-2" />
            <div className="flex min-w-[140px] flex-1 flex-col gap-[6px]">
              <div className="flex justify-between gap-2">
                <span className="truncate text-[14px] font-semibold">{f.name}</span>
                <span className="flex-none font-mono text-[12px] text-fg-2">
                  {final
                    ? formatBytes(f.size, locale)
                    : `${percent(f.done ? f.size : f.verified, f.size)} · ${formatBytes(f.size, locale)}`}
                </span>
              </div>
              {!final && (
                <ProgressBar value={f.size ? (f.done ? 1 : f.verified / f.size) : 1} label={f.name} height={4} />
              )}
              {final && f.savedAs && s.target?.folderName && (
                <span className="text-[12px] text-fg-2">
                  {t('product.rx_saved_in', { folder: s.target.folderName })}
                </span>
              )}
            </div>
            {final && f.done && !f.savedAs && (
              <Button
                size="sm"
                icon={Download}
                onClick={() => void rx.save(f.index)}
                aria-label={t('product.rx_download_named', { name: f.name })}
              >
                {t('product.rx_download')}
              </Button>
            )}
            {final && f.failed && <FileX aria-label={t('web.st.failed')} size={18} className="text-danger-ink" />}
          </li>
        ))}
      </ul>
    </Card>
  );

  if (rxFinal(s.phase)) {
    const done = s.files.filter((f) => f.done).length;
    return (
      <Screen id="receive-done">
        <div
          className="mx-auto flex w-full max-w-[640px] flex-col gap-4"
          data-testid="receive-result"
          data-result={s.phase}
        >
          {s.phase === 'completed' ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <span
                aria-hidden
                className="flex h-[76px] w-[76px] items-center justify-center rounded-full bg-receive-soft text-receive-ink"
              >
                <Check size={36} />
              </span>
              <h1 className="m-0 text-[28px]">{t('web.done_h')}</h1>
              <span className="inline-flex items-center gap-[6px] text-[13px] font-semibold text-receive-ink">
                <ShieldCheck aria-hidden size={16} />
                {t('product.rx_verified', {
                  count:
                    s.files.length === 1
                      ? t('product.files_count_one')
                      : t('product.files_count', { n: s.files.length }),
                  size: formatBytes(s.total, locale),
                })}
              </span>
            </div>
          ) : (
            <div
              role={s.phase === 'failed' ? 'alert' : 'status'}
              className="flex flex-col items-center gap-3 py-2 text-center"
            >
              <span
                aria-hidden
                className={`flex h-[76px] w-[76px] items-center justify-center rounded-full ${s.phase === 'failed' ? 'bg-danger-soft text-danger-ink' : 'bg-warning-soft text-warning-ink'}`}
              >
                {s.phase === 'failed' ? <FileX size={36} /> : <CircleDashed size={36} />}
              </span>
              <h1 className="m-0 text-[26px]">
                {s.phase === 'partial'
                  ? t('product.rx_partial_h', { done, count: s.files.length })
                  : t(s.phase === 'failed' ? 'product.rx_failed_h' : 'product.rx_cancelled_h')}
              </h1>
              <p className="m-0 max-w-[440px] text-[14px] leading-[1.5] text-fg-2">
                {s.error ? t(s.error) : s.phase === 'partial' ? t('product.rx_partial_p') : ''}
              </p>
            </div>
          )}
          {fileList(true)}
          {s.target?.mode === 'opfs' && s.files.some((f) => f.done) && (
            <p className="m-0 text-center text-[13px] text-fg-2">{t('product.rx_kept')}</p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <Link
              to="/"
              className="inline-flex h-[46px] items-center rounded-[12px] border border-border-strong bg-surface px-[18px] text-[14px] font-semibold text-fg no-underline"
            >
              {t('common.done')}
            </Link>
          </div>
        </div>
      </Screen>
    );
  }

  const running = s.phase !== 'paused';
  return (
    <Screen id="receive-progress">
      <KeepOpenBanner state={pill} />
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <span className="text-[13px] font-semibold text-fg-2">{t('product.rx_from', { name: senderName })}</span>
            <h1 className="m-0 mt-1 text-[clamp(24px,3vw,30px)] tracking-[-0.025em]">{t('web.receiving')}</h1>
          </div>
          {/* The route is known only while a channel is open; hidden while (re)connecting. */}
          <RouteChip
            route={s.phase === 'reconnecting' || s.phase === 'connecting' || s.phase === 'unreachable' ? null : s.route}
            kind={s.routeKind}
          />
        </div>
        <Card className="flex flex-col gap-3 px-[20px] py-[18px]" as="section">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <b className="text-[28px]" data-testid="rx-percent">
              {percent(s.verified, s.total)}
            </b>
            <TransferChip state={CHIP[s.phase] ?? 'connecting'} />
          </div>
          <ProgressBar
            value={s.total ? s.verified / s.total : 1}
            label={t('web.receiving')}
            height={10}
            tone={barTone(s.phase)}
          />
          <div className="flex flex-wrap justify-between gap-3 font-mono text-[13px] text-fg-2">
            <span data-testid="rx-bytes">
              {t('product.bytes_of', { done: formatBytes(s.verified, locale), total: formatBytes(s.total, locale) })}
            </span>
            <span>
              {speed(s.bytesPerSecond)} · {s.phase === 'paused' ? t('web.st.paused') : eta(s.eta)}
            </span>
          </div>
          {s.phase === 'reconnecting' && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-[10px] bg-warning-soft px-3 py-[10px] text-[13px] text-warning-ink"
            >
              <WifiOff aria-hidden size={16} />
              {t(s.verified > 0 ? 'product.rx_reconnecting' : 'product.rx_connecting')}
            </div>
          )}
          {s.phase === 'unreachable' && (
            <Banner
              tone="danger"
              role="alert"
              title={t('product.tx_err_unreachable')}
              action={
                <Button size="sm" variant="send" onClick={() => rx.retry()}>
                  {t('common.retry')}
                </Button>
              }
            />
          )}
          {s.phase === 'verifying' && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-[10px] bg-send-soft px-3 py-[10px] text-[13px] text-send-ink"
            >
              <ShieldCheck aria-hidden size={16} />
              {t('product.verifying_sha')}
            </div>
          )}
          {s.error && <Banner tone="warning" role="alert" title={t(s.error)} />}
          <div className="flex flex-wrap gap-2">
            {s.phase === 'unreachable' || s.phase === 'verifying' ? null : running ? (
              <Button icon={Pause} onClick={() => rx.pause()}>
                {t('web.pause')}
              </Button>
            ) : (
              <Button variant="send" icon={Play} onClick={() => void rx.resume()}>
                {t('web.resume')}
              </Button>
            )}
            <Button variant="danger-ghost" onClick={() => setConfirmCancel(true)}>
              {t('web.cancel')}
            </Button>
            <span className="flex-1" />
            <Button variant="ghost" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
              {t('web.details')}
            </Button>
          </div>
          {showLog && <ConnectionLog lines={s.log} />}
        </Card>
        {fileList(false)}
        <SecurityWords words={words} label={t('web_xx.secw_r')} />
      </div>
      <ConfirmDialog
        open={confirmCancel}
        title={t('product.rx_cancel_h')}
        body={t('product.rx_cancel_p')}
        confirmLabel={t('web.cancel')}
        cancelLabel={t('product.rx_keep')}
        danger
        onConfirm={() => {
          setConfirmCancel(false);
          void rx.cancel();
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </Screen>
  );
}
