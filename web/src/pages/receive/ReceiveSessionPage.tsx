import { CircleX, Hourglass, TimerOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button, Screen } from '../../components/ui';
import { KeepOpenBanner } from '../../components/KeepOpenBanner';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { useKeepAwake } from '../../lib/keepAwake/KeepAwakeContext';
import { useIdentity } from '../../lib/identity/identity';
import { platformLabel } from '../../lib/api/device-client';
import type { SessionView } from '../../features/sharing/api';
import { SecurityWords } from '../../features/sharing/ParticipantCard';
import { useSharing, useSocketEvents } from '../../features/sharing/SharingContext';
import { useReceiver } from '../../features/transfer/TransferContext';
import { rxActive } from '../../features/transfer/runtime/receiver-controller';
import { ReceiveTransfer } from './ReceiveTransfer';

type Outcome = 'removed' | 'blocked' | 'rejected' | 'left' | 'closed' | 'ended';

const OUTCOME: Record<Outcome, { screen: string; title: string; body?: string }> = {
  // RX-5 `receive-wait` covers the declined outcome; every other ending is RX-7 `receive-done` (UX_SCREEN_MAP §12).
  removed: { screen: 'receive-done', title: 'product.removed_rx' },
  blocked: { screen: 'receive-done', title: 'product.blocked_rx' },
  rejected: { screen: 'receive-wait', title: 'product.declined_h', body: 'product.declined_p' },
  left: { screen: 'receive-done', title: 'product.left_rx' },
  closed: { screen: 'receive-done', title: 'product.closed_rx' },
  ended: { screen: 'receive-done', title: 'product.session_ended_rx' },
};

function outcomeOf(v: SessionView | null, gone: boolean): Outcome | null {
  if (gone) return 'ended';
  if (!v) return null;
  switch (v.me?.status) {
    case 'REMOVED':
      return 'removed';
    case 'BLOCKED':
      return 'blocked';
    case 'REJECTED':
      return 'rejected';
    case 'LEFT':
      return 'left';
  }
  if (v.status === 'CLOSED') return 'closed';
  // The session finished: this receiver's own result (RX-7) comes from its transfers, not an outcome screen.
  if (v.status === 'COMPLETED' || v.status === 'PARTIALLY_COMPLETED') return null;
  if (v.status !== 'WAITING' && v.status !== 'ACTIVE') return 'ended';
  return null;
}

/**
 * Receiver side of a session: RX-5 waiting for approval (`receive-wait`), then the transfer itself
 * (RX-5b save location, RX-6 receiving, RX-7 result, in ReceiveTransfer), and the RX-7 outcomes (removed,
 * blocked, declined, closed, expired).
 */
export default function ReceiveSessionPage() {
  const { sessionId = '' } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { api } = useSharing();
  const { device } = useIdentity();
  const [view, setView] = useState<SessionView | null>(null);
  const [gone, setGone] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.get(sessionId));
      setFailed(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else setFailed(true);
    }
  }, [api, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useSocketEvents((e) => {
    if (e.type === 'SOCKET_OPEN' || e.session_id === sessionId) void load();
  });

  const outcome = outcomeOf(view, gone);
  const [rx, rxState] = useReceiver(sessionId, view?.me?.status === 'JOINED');
  const finishedFiles = rxState.phase === 'completed' || rxState.phase === 'partial';
  useEffect(() => {
    // Removed, blocked, left, or the session ended: stop receiving and discard unfinished files.
    if (outcome && outcome !== 'rejected' && (rxActive(rxState.phase) || rxState.phase === 'paused'))
      rx.endedElsewhere();
  }, [outcome, rx, rxState.phase, rxState.files.length]);
  const waiting = !outcome && view?.me?.status === 'REQUESTED';
  // RX-5: keep the screen on while waiting for the sender's approval (docs/ARCHITECTURE.md §7.1).
  const pill = useKeepAwake(!!waiting);

  const [leaveError, setLeaveError] = useState(false);
  const leave = async () => {
    if (!view?.me) return;
    setLeaving(true);
    setLeaveError(false);
    try {
      await api.decide(view.me.id, 'leave');
      navigate('/receive', { replace: true });
    } catch {
      setLeaveError(true);
      setLeaving(false);
    }
  };

  if (outcome && finishedFiles && (outcome === 'closed' || outcome === 'ended')) {
    return (
      <ReceiveTransfer
        sessionId={sessionId}
        senderName={view?.sender?.display_name ?? ''}
        words={view?.me?.security_words}
      />
    );
  }
  if (outcome) {
    const o = OUTCOME[outcome];
    const Icon = outcome === 'closed' || outcome === 'ended' ? TimerOff : CircleX;
    return (
      <Screen id={o.screen}>
        <div
          className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-3 text-center"
          data-testid="receive-outcome"
          data-outcome={outcome}
        >
          <Icon aria-hidden size={36} className="text-fg-2" />
          <h1 className="m-0 text-[clamp(22px,3vw,28px)]">{t(o.title)}</h1>
          {o.body && <p className="m-0 text-fg-2">{t(o.body)}</p>}
          <Link to="/receive" className="font-semibold">
            {t('product.another_code')}
          </Link>
        </div>
      </Screen>
    );
  }
  if (!view) {
    return (
      <Screen id="receive-wait">
        {failed && (
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
        <div aria-hidden className="mx-auto h-[240px] w-full max-w-[560px] animate-pulse rounded-[16px] bg-surface-2" />
      </Screen>
    );
  }
  const senderName = view.sender?.display_name ?? '';
  const myDevice = device?.display_name ?? platformLabel();
  if (waiting) {
    return (
      <Screen id="receive-wait">
        <KeepOpenBanner state={pill} />
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
          <div className="flex flex-col items-center gap-3 pt-8 text-center">
            <span
              aria-hidden
              className="flex h-[72px] w-[72px] animate-pulse items-center justify-center rounded-full bg-send-soft text-send-ink motion-reduce:animate-none"
            >
              <Hourglass size={30} />
            </span>
            <h1 className="m-0 text-[clamp(22px,3vw,28px)]">{t('web.waiting')}</h1>
            <p className="m-0 max-w-[400px] leading-[1.55] text-fg-2">
              <NameIn text={t('product.waiting_body', { name: senderName, device: NAME_SLOT })} name={myDevice} />
            </p>
            {view.me?.request_reason === 'protected_mode' && (
              <Banner tone="warning" title={t('product.protected_mode')} />
            )}
            <SecurityWords words={view.me?.security_words} label={t('web_xx.secw_r')} center />
            {leaveError && <Banner tone="danger" role="alert" title={t('product.leave_failed')} />}
            <Button variant="secondary" busy={leaving} onClick={() => void leave()}>
              {t('web.cancel')}
            </Button>
          </div>
        </div>
      </Screen>
    );
  }
  return <ReceiveTransfer sessionId={sessionId} senderName={senderName} words={view.me?.security_words} />;
}

const NAME_SLOT = '\u0000';
/** Renders a translated sentence with this device's name in bold, as in the design. */
function NameIn({ text, name }: { text: string; name: string }) {
  const [before = '', after = ''] = text.split(NAME_SLOT);
  return (
    <>
      {before}
      <b className="text-fg">{name}</b>
      {after}
    </>
  );
}
