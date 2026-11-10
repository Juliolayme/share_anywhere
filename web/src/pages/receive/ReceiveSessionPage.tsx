import { CircleCheck, CircleX, File as FileIcon, Hourglass, TimerOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button, Card, Screen } from '../../components/ui';
import { KeepOpenBanner } from '../../components/KeepOpenBanner';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { formatBytes } from '../../lib/format';
import { useKeepAwake } from '../../lib/keepAwake/KeepAwakeContext';
import type { SessionView } from '../../features/sharing/api';
import { SecurityWords } from '../../features/sharing/ParticipantCard';
import { useSharing, useSocketEvents } from '../../features/sharing/SharingContext';

type Outcome = 'removed' | 'blocked' | 'rejected' | 'left' | 'closed' | 'ended';

const OUTCOME: Record<Outcome, { screen: string; title: string; body?: string }> = {
  removed: { screen: 'receive-removed', title: 'product.removed_rx' },
  blocked: { screen: 'receive-blocked', title: 'product.blocked_rx' },
  rejected: { screen: 'receive-wait', title: 'product.declined_h', body: 'product.declined_p' },
  left: { screen: 'receive-left', title: 'product.left_rx' },
  closed: { screen: 'session-expired', title: 'product.closed_rx' },
  ended: { screen: 'session-expired', title: 'product.session_ended_rx' },
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
  if (v.status !== 'WAITING' && v.status !== 'ACTIVE') return 'ended';
  return null;
}

/**
 * Receiver side of a session: RX-5 waiting for approval (`receive-wait`), joined and waiting for transfers to
 * start (Phase 3), and RX-7 outcomes (removed, blocked, declined, closed, expired).
 */
export default function ReceiveSessionPage() {
  const { sessionId = '' } = useParams();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { api } = useSharing();
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
  const waiting = !outcome && view?.me?.status === 'REQUESTED';
  // RX-5: keep the screen on while waiting for the sender's approval (docs/ARCHITECTURE.md §7.1).
  const pill = useKeepAwake(!!waiting);

  const leave = async () => {
    if (!view?.me) return;
    setLeaving(true);
    try {
      await api.decide(view.me.id, 'leave');
    } finally {
      navigate('/receive', { replace: true });
    }
  };

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
  if (waiting) {
    return (
      <Screen id="receive-wait">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
          <KeepOpenBanner state={pill} />
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              aria-hidden
              className="flex h-[56px] w-[56px] items-center justify-center rounded-[16px] bg-warning-soft text-warning-ink"
            >
              <Hourglass size={26} />
            </span>
            <h1 className="m-0 text-[clamp(22px,3vw,28px)]">{t('web.waiting')}</h1>
            <p className="m-0 text-fg-2">{t('product.waiting_body', { name: senderName })}</p>
            {view.me?.request_reason === 'protected_mode' && (
              <Banner tone="warning" title={t('product.protected_mode')} />
            )}
            <SecurityWords words={view.me?.security_words} label={t('web_xx.secw_r')} />
            <Button variant="secondary" busy={leaving} onClick={() => void leave()}>
              {t('web.cancel')}
            </Button>
          </div>
        </div>
      </Screen>
    );
  }
  return (
    <Screen id="receive-joined">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
        <div className="flex items-start gap-3 rounded-[12px] bg-receive-soft p-4 text-receive-ink">
          <CircleCheck aria-hidden size={22} className="flex-none" />
          <div>
            <b data-testid="joined-title">{t('product.joined_session', { name: senderName })}</b>
            <div className="text-caption">{t('product.files_pending')}</div>
          </div>
        </div>
        <SecurityWords words={view.me?.security_words} label={t('web_xx.secw_r')} />
        <Card className="flex flex-col gap-2 p-[18px]">
          {(view.files ?? []).map((f) => (
            <div key={f.id} className="flex items-center gap-3 text-[14px]">
              <FileIcon aria-hidden size={16} className="flex-none text-fg-2" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="font-mono text-[12px] text-fg-2">{formatBytes(f.size, locale)}</span>
              <span className="rounded-[7px] bg-surface-2 px-2 text-[12px] font-semibold text-fg-2">
                {t('common.queued')}
              </span>
            </div>
          ))}
        </Card>
        <Button variant="ghost" busy={leaving} onClick={() => void leave()}>
          {t('product.leave')}
        </Button>
      </div>
    </Screen>
  );
}
