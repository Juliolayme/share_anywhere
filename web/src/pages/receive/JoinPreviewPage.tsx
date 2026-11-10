import { ChevronLeft, File as FileIcon, Laptop, ShieldCheck, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Banner, Button, Card, Screen } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { formatBytes } from '../../lib/format';
import { mmss, secondsUntil, type JoinPreview } from '../../features/sharing/api';
import { IdentityBadge } from '../../features/sharing/ParticipantCard';
import { useSharing } from '../../features/sharing/SharingContext';
import { joinErrorMessage } from '../../features/sharing/errors';

export interface PreviewState {
  preview: JoinPreview;
  offset: number;
}

/**
 * RX-4 / design screen `receive-preview`: who is sending what, "Join within m:ss" in the last minute of the
 * join window, the expired message if the window ends before Receive, and Receive. Opening a link lands here
 * without the Welcome screen.
 */
export default function JoinPreviewPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { api } = useSharing();
  const state = useLocation().state as PreviewState | null;
  const [now, setNow] = useState(() => Date.now());
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!state?.preview) return <Navigate to="/receive" replace />;
  const { preview, offset } = state;
  const left = secondsUntil(preview.join_window_ends_at, offset, now);
  const ticketLeft = secondsUntil(preview.join_ticket_expires_at, offset, now);
  const expired = left === 0 || ticketLeft === 0;
  const sender = preview.sender;
  const Icon = /android|iphone|ios|mobile/i.test(sender.platform) ? Smartphone : Laptop;
  const title =
    preview.file_count === 1
      ? t('product.preview_title_one', { name: sender.display_name })
      : t('product.preview_title', { name: sender.display_name, n: preview.file_count });

  const receive = async () => {
    setJoining(true);
    setError(null);
    try {
      const res = await api.join(preview.session_id, preview.join_ticket);
      navigate(`/receive/${preview.session_id}`, { replace: true, state: { participant: res.participant } });
    } catch (e) {
      setError(joinErrorMessage(t, e));
      setJoining(false);
    }
  };

  return (
    <Screen id="receive-preview">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
        <Link
          to="/receive"
          className="flex items-center gap-[6px] self-start text-caption font-semibold text-fg-2 no-underline hover:text-fg"
        >
          <ChevronLeft aria-hidden size={16} />
          {t('product.change_code')}
        </Link>
        <h1 className="m-0 text-[clamp(24px,3vw,30px)] font-bold tracking-[-0.025em]">{title}</h1>
        <Card className="flex flex-col gap-3 p-[18px]">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-[44px] w-[44px] items-center justify-center rounded-[12px] bg-surface-2"
            >
              <Icon size={20} />
            </span>
            <div className="flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <b>{sender.display_name}</b>
                <IdentityBadge signedIn={sender.signed_in} />
              </span>
              <div className="text-caption text-fg-2">
                {t('product.rx_sender_line', { platform: sender.platform, time: mmss(left) })}
              </div>
            </div>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {preview.files.map((f) => (
              <li key={f.id} className="flex items-center gap-3 text-[14px]">
                <FileIcon aria-hidden size={16} className="flex-none text-fg-2" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="font-mono text-[12px] text-fg-2">{formatBytes(f.size, locale)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-border pt-3">
            <b>{t('web.total')}</b>
            <b className="font-mono">{formatBytes(preview.total_bytes, locale)}</b>
          </div>
        </Card>
        <div className="flex items-start gap-2 text-caption text-fg-2">
          <ShieldCheck aria-hidden size={16} className="mt-[1px] flex-none text-receive-ink" />
          {t('product.preview_secure')}
        </div>
        {(preview.protected_mode || preview.require_approval) && (
          <Banner
            tone="warning"
            title={preview.protected_mode ? t('product.protected_mode') : t('product.waiting_sender')}
          />
        )}
        {error && <Banner tone="danger" role="alert" title={error} />}
        {expired ? (
          <Banner tone="warning" role="alert" title={t('common.cx_rx')} />
        ) : (
          <>
            <Button variant="receive" size="lg" busy={joining} onClick={() => void receive()}>
              {joining ? t('product.joining') : t('product.receive_cta')}
            </Button>
            {left <= 60 && (
              <span className="text-center text-caption text-fg-2" data-testid="join-within">
                {t('product.join_within', { time: mmss(Math.min(left, ticketLeft)) })}
              </span>
            )}
          </>
        )}
      </div>
    </Screen>
  );
}
