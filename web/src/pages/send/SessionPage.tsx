import { Copy, Check, Link2, Lock, Share2, TimerOff, Clock, UserCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button, Card, ConfirmDialog, Screen, Switch } from '../../components/ui';
import { KeepOpenBanner } from '../../components/KeepOpenBanner';
import { QRCode } from '../../components/QRCode';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { formatBytes } from '../../lib/format';
import { useKeepAwake } from '../../lib/keepAwake/KeepAwakeContext';
import { mmss, secondsUntil, serverOffset, type Participant, type SessionView } from '../../features/sharing/api';
import { ParticipantCard } from '../../features/sharing/ParticipantCard';
import { ExpiryAnnouncer } from '../../features/sharing/ExpiryAnnouncer';
import { useSharing, useSocketEvents } from '../../features/sharing/SharingContext';
import { useSender } from '../../features/transfer/TransferContext';
import { txActive, type TxReceiver } from '../../features/transfer/runtime/sender-controller';
import { ProgressBar, TransferChip, barTone, percent, type ChipState } from '../../features/transfer/ui';

const LIVE = new Set(['WAITING', 'ACTIVE']);

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * TR-4/TR-5 / design screens `session`, `session-full`, `session-expired`, `session-approved`: share panel
 * (QR, six-digit code, link) with the 10:00 join-window countdown, receivers with security words and
 * Remove/Block, join requests, Stop accepting, Require approval, protected-mode notice, close dialog (TR-8).
 */
export default function SessionPage() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { api } = useSharing();
  const [view, setView] = useState<SessionView | null>(null);
  const [offset, setOffset] = useState(0);
  const [loadError, setLoadError] = useState<'not_found' | 'error' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [blockTarget, setBlockTarget] = useState<Participant | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    try {
      const v = await api.get(id);
      setView(v);
      setOffset(serverOffset(v.server_time));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError && e.status === 404 ? 'not_found' : 'error');
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useSocketEvents((e) => {
    if (e.type === 'SOCKET_OPEN' || e.type === 'PROTECTED_MODE') {
      void load();
      return;
    }
    if (e.session_id !== id) return;
    if (e.type === 'PARTICIPANT_JOINED') {
      const p = e.participant as Participant;
      toast.show(t('product.peer_joined', { name: p.display_name }));
    }
    if (e.type === 'PARTICIPANT_REQUESTED') {
      const p = e.participant as Participant;
      toast.show(t('product.wants_to_join', { name: p.display_name }));
    }
    void load();
  });

  const live = !!view && LIVE.has(view.status);
  const win = view?.join_window;
  const left = win ? secondsUntil(win.ends_at, offset, now) : 0;
  const windowOpen = live && win?.state === 'OPEN' && left > 0;
  // Refresh when the countdown reaches zero so the expired state comes from the server.
  useEffect(() => {
    if (live && win?.state === 'OPEN' && left === 0) {
      const tm = setTimeout(() => void load(), 1200);
      return () => clearTimeout(tm);
    }
  }, [live, win?.state, left, load]);

  // The sender's engine answers receivers' offers while this screen (or the dashboard) is open.
  const [, txState] = useSender(id, live && view?.role === 'sender');
  const transferring = txState.receivers.some((r) => txActive(r.status));
  // The screen stays on while the join window is open or transfers run (docs/ARCHITECTURE.md §7.1).
  // A tab that only mirrors another tab's transfer (txState.elsewhere) leaves the screen to that tab.
  const pill = useKeepAwake((windowOpen && !txState.elsewhere) || (txState.hasFiles && transferring));

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      toast.show(
        e instanceof ApiError && e.code === 'session_full' ? t('product.session_full_rx') : t('product.error_generic'),
      );
      await load();
    } finally {
      setBusy(null);
    }
  };

  const copy = async (what: 'code' | 'link', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      toast.show(t('common.n_copied'));
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.show(t('product.error_generic'));
    }
  };

  if (loadError === 'not_found') {
    return (
      <Screen id="session">
        <Banner tone="danger" role="alert" title={t('product.session_expired_s')} />
        <Link to="/" className="font-semibold">
          {t('product.back_home')}
        </Link>
      </Screen>
    );
  }
  if (!view) {
    return (
      <Screen id="session">
        {loadError && (
          <Banner
            tone="danger"
            role="alert"
            title={t('product.error_generic')}
            action={
              <Button size="sm" onClick={() => void load()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        <div aria-hidden className="h-[320px] animate-pulse rounded-[16px] bg-surface-2" />
      </Screen>
    );
  }

  const cap = view.capacity ?? { joined: 0, requested: 0, max: 5 };
  const taken = cap.joined + cap.requested;
  const full = taken >= cap.max;
  const receivers = (view.participants ?? []).filter((p) => p.status === 'JOINED' || p.status === 'REQUESTED');
  const requests = receivers.filter((p) => p.status === 'REQUESTED');
  const joined = receivers.filter((p) => p.status === 'JOINED');
  // Design screen IDs (docs/UX_SCREEN_MAP.md §12): full, code expired or not accepting, approval on, open.
  const screenId = full
    ? 'session-full'
    : !windowOpen
      ? 'session-expired'
      : view.require_approval
        ? 'session-approved'
        : 'session';
  const filesLabel =
    view.file_count === 1 ? t('product.files_count_one') : t('product.files_count', { n: view.file_count });

  // Every transfer has ended with something delivered (docs/ARCHITECTURE.md §4.5): show the result (TR-7).
  if (view.status === 'COMPLETED' || view.status === 'PARTIALLY_COMPLETED')
    return <Navigate to={`/send/session/${id}/result`} replace />;
  if (!live) {
    return (
      <Screen id="session-ended">
        <div className="flex flex-col items-start gap-3">
          <h1 className="m-0 text-[clamp(24px,3vw,30px)]">
            {view.status === 'CLOSED' ? t('product.session_closed') : t('product.session_expired_s')}
          </h1>
          <div className="flex gap-2">
            <Button variant="send" onClick={() => navigate('/send')}>
              {t('product.new_session')}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/')}>
              {t('product.back_home')}
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen id={screenId}>
      {!txState.elsewhere && <KeepOpenBanner state={pill} />}
      {txState.loaded && !txState.hasFiles && txState.elsewhere && (
        <Banner tone="info" role="status" title={t('product.tx_other_tab')} />
      )}
      {txState.loaded && !txState.hasFiles && !txState.elsewhere && (
        <Banner tone="warning" role="alert" title={t('product.tx_no_files')} />
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-caption font-semibold text-fg-2">
            {t('product.step_two', { files: filesLabel, total: formatBytes(view.total_bytes, locale) })}
          </span>
          <h1 className="m-0 text-[clamp(24px,3vw,30px)] font-bold tracking-[-0.025em]">{t('web.share_h')}</h1>
        </div>
        <Button variant="secondary" onClick={() => setConfirmClose(true)}>
          {t('web.close')}
        </Button>
      </div>
      {view.protected_mode && <Banner tone="warning" title={t('product.protected_mode_sender')} />}
      {windowOpen && cap.joined > 0 && (
        <Banner
          tone="info"
          title={t('product.stop_nudge')}
          action={
            <Button
              size="sm"
              variant="secondary"
              busy={busy === 'stop'}
              onClick={() => void act('stop', () => api.update(id, { accepting_receivers: false }))}
            >
              {t('product.stop_accepting')}
            </Button>
          }
        />
      )}
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))]">
        <Card as="section" className="flex flex-col gap-4 p-[clamp(16px,3vw,24px)]">
          <h2 className="sr-only">{t('web.share_h')}</h2>
          {windowOpen && view.code && view.join_url ? (
            <>
              <div className="flex flex-wrap items-center justify-center gap-[18px]">
                <QRCode value={view.join_url} label={t('product.qr_aria')} />
                <div className="flex min-w-[180px] flex-1 flex-col gap-2">
                  <span className="text-caption font-semibold text-fg-2">{t('web.code')}</span>
                  <div className="flex items-center gap-2">
                    <span
                      data-testid="session-code"
                      aria-label={t('product.code_aria', { code: view.code.split('').join(' ') })}
                      className="min-w-0 font-mono text-[clamp(30px,4vw,38px)] font-medium leading-[1.2] tracking-[0.08em]"
                    >
                      {view.code.slice(0, 3)}
                      <span aria-hidden className="inline-block w-3" />
                      {view.code.slice(3)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void copy('code', view.code ?? '')}
                      aria-label={t('product.copy_code')}
                      className="flex h-[44px] w-[44px] flex-none items-center justify-center rounded-md bg-surface-2 text-fg hover:bg-border"
                    >
                      {copied === 'code' ? <Check aria-hidden size={18} /> : <Copy aria-hidden size={18} />}
                    </button>
                  </div>
                  <span className="text-caption text-fg-2">{t('web.scan')}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex min-w-0 flex-1 items-center gap-2 truncate rounded-md bg-surface-2 px-3 py-2 font-mono text-caption">
                  <Link2 aria-hidden size={16} className="flex-none" />
                  <span className="truncate" data-testid="session-link">
                    {view.join_url}
                  </span>
                </span>
                <Button
                  size="sm"
                  icon={copied === 'link' ? Check : Copy}
                  onClick={() => void copy('link', view.join_url ?? '')}
                >
                  {t('product.copy_link')}
                </Button>
                {typeof navigator.share === 'function' && (
                  <Button
                    size="sm"
                    icon={Share2}
                    onClick={() => void navigator.share({ url: view.join_url ?? '' }).catch(() => undefined)}
                  >
                    {t('web.share')}
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-[10px] text-caption text-fg-2">
                <span className="inline-flex items-center gap-2">
                  <Clock aria-hidden size={14} />
                  {t('common.cx_valid')}
                  <span className="whitespace-nowrap">
                    ·{' '}
                    <b
                      data-testid="countdown"
                      className={`font-mono ${left <= 60 ? 'text-warning-ink' : 'text-fg'}`}
                      role="timer"
                      aria-live="off"
                    >
                      {mmss(left)}
                    </b>
                  </span>
                  <ExpiryAnnouncer left={left} />
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  busy={busy === 'stop'}
                  onClick={() => void act('stop', () => api.update(id, { accepting_receivers: false }))}
                >
                  {t('product.stop_accepting')}
                </Button>
              </div>
            </>
          ) : win?.state === 'ENDED_FULL' && full ? (
            <div role="status" className="flex flex-col items-start gap-2">
              <Lock aria-hidden size={22} className="text-fg-2" />
              <b>{t('product.capacity_full')}</b>
              <span className="text-caption text-fg-2">{t('product.session_full_s')}</span>
              <Button variant="secondary" disabled>
                {t('common.cx_btn')}
              </Button>
            </div>
          ) : (
            <div role="alert" className="flex flex-col items-start gap-2" data-testid="code-expired">
              <TimerOff aria-hidden size={22} className="text-warning-ink" />
              <b>{win?.state === 'ENDED_BY_SENDER' ? t('product.not_accepting_s') : t('common.cx_h')}</b>
              <span className="text-caption text-fg-2">{t('common.cx_p')}</span>
              <Button
                variant="send"
                disabled={full}
                busy={busy === 'renew'}
                onClick={() => void act('renew', () => api.renew(id))}
              >
                {t('common.cx_btn')}
              </Button>
            </div>
          )}
        </Card>
        <Card as="section" className="flex flex-col gap-4 p-[clamp(16px,3vw,24px)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-[16px]">
              {t('web.receivers')} · {taken}/{cap.max}
            </h2>
            <span className="inline-flex items-center gap-1 text-caption text-fg-2" data-testid="slots">
              {full && <Lock aria-hidden size={14} />}
              {full ? t('product.capacity_full') : t('product.slots_left', { n: cap.max - taken })}
            </span>
          </div>
          <div
            className="flex gap-1"
            role="img"
            aria-label={full ? t('product.capacity_full') : t('product.slots_left', { n: cap.max - taken })}
          >
            {Array.from({ length: cap.max }, (_, i) => (
              <span
                key={i}
                className={`h-[6px] flex-1 rounded-full ${i < cap.joined ? 'bg-receive' : i < taken ? 'bg-warning' : 'bg-track'}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 rounded-[12px] bg-bg p-3">
            <Switch
              checked={view.require_approval}
              label={t('web.reqappr')}
              disabled={busy === 'approval'}
              onChange={(v) => void act('approval', () => api.update(id, { require_approval: v }))}
            />
            <span>
              <b className="flex items-center gap-1 text-[14px]">
                <UserCheck aria-hidden size={14} />
                {t('web.reqappr')}
              </b>
              <span className="block text-[12px] text-fg-2">
                {t(view.require_approval ? 'product.appr_on' : 'product.appr_off')}
              </span>
            </span>
          </div>
          {[...requests, ...joined].map((p) => (
            <ParticipantCard
              key={p.id}
              p={p}
              busy={busy === p.id}
              onApprove={() => void act(p.id, () => api.decide(p.id, 'approve'))}
              onReject={() => void act(p.id, () => api.decide(p.id, 'reject'))}
              onRemove={() => void act(p.id, () => api.remove(p.id))}
              onBlock={() => setBlockTarget(p)}
            >
              {p.status === 'JOINED' && <TransferLine r={txState.receivers.find((r) => r.participantId === p.id)} />}
            </ParticipantCard>
          ))}
          {receivers.length === 0 && (
            <div
              className="flex flex-col items-center gap-2 rounded-[12px] border border-dashed border-border-strong p-[20px] text-center"
              data-testid="no-receivers"
            >
              <b>{t('web.waiting_r')}</b>
              <span className="text-caption text-fg-2">
                {t(view.require_approval ? 'product.empty_receivers_appr' : 'product.empty_receivers')}
              </span>
            </div>
          )}
          {joined.length > 0 && (
            <Button variant="send" onClick={() => navigate(`/send/session/${id}/transfers`)}>
              {t('product.view_transfers')}
            </Button>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={confirmClose}
        title={t('product.close_h')}
        body={t('product.close_p')}
        confirmLabel={t('web.close')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy === 'close'}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() =>
          void act('close', () => api.close(id)).then(() => {
            setConfirmClose(false);
          })
        }
      />
      <ConfirmDialog
        open={!!blockTarget}
        title={t('product.block_confirm_h')}
        body={t('product.block_confirm_p')}
        confirmLabel={t('product.block')}
        cancelLabel={t('common.cancel')}
        danger
        busy={!!blockTarget && busy === blockTarget.id}
        onCancel={() => setBlockTarget(null)}
        onConfirm={() => {
          const p = blockTarget;
          if (!p) return;
          void act(p.id, () => api.decide(p.id, 'block')).then(() => setBlockTarget(null));
        }}
      />
    </Screen>
  );
}

/** A joined receiver's transfer at a glance (full detail on the dashboard). */
function TransferLine({ r }: { r: TxReceiver | undefined }) {
  const { t } = useI18n();
  if (!r) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="participant-transfer">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <TransferChip state={r.status as ChipState} />
        <span className="font-mono text-fg-2">
          {r.status === 'waiting'
            ? t('product.transfer_waiting')
            : r.status === 'offline'
              ? t('product.transfer_offline')
              : percent(r.verified, r.total)}
        </span>
      </div>
      <ProgressBar value={r.total ? r.verified / r.total : 0} label={r.name} height={4} tone={barTone(r.status)} />
    </div>
  );
}
