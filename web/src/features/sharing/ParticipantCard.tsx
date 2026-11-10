import type { ReactNode } from 'react';
import { Check, Hourglass, Laptop, ShieldCheck, Smartphone, UserX, Ban, User } from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import type { Participant } from './api';

const mobile = (p: string) => /android|iphone|ios|mobile/i.test(p);

export function IdentityBadge({ signedIn }: { signedIn: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1 rounded-sm px-[7px] text-[11px] font-bold ${signedIn ? 'bg-send-soft text-send-ink' : 'bg-surface-2 text-fg-2'}`}
    >
      {signedIn ? <ShieldCheck aria-hidden size={12} /> : <User aria-hidden size={12} />}
      {t(signedIn ? 'product.badge_signed_in' : 'product.badge_guest')}
    </span>
  );
}

export function SecurityWords({
  words,
  label,
  center = false,
}: {
  words?: string[] | undefined;
  label: string;
  center?: boolean;
}) {
  if (!words || words.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 text-caption text-fg-2 ${center ? 'justify-center' : ''}`}>
      <ShieldCheck aria-hidden size={14} className="text-receive-ink" />
      <span>{label}</span>
      <b data-testid="security-words" className="font-mono text-fg">
        {words.join(' · ')}
      </b>
    </div>
  );
}

/** Participant card (DESIGN_SYSTEM ParticipantCard): joined receiver or join request, with sender actions. */
export function ParticipantCard({
  p,
  busy,
  onApprove,
  onReject,
  onRemove,
  onBlock,
  children,
}: {
  p: Participant;
  children?: ReactNode;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRemove: () => void;
  onBlock: () => void;
}) {
  const { t } = useI18n();
  const Icon = mobile(p.platform) ? Smartphone : Laptop;
  const requested = p.status === 'REQUESTED';
  return (
    <div
      role="group"
      aria-label={p.display_name}
      data-testid={requested ? 'request-card' : 'participant-card'}
      className={`flex flex-col gap-3 border ${requested ? 'rounded-lg border-send bg-send-soft p-4' : 'rounded-[12px] border-border bg-surface p-3'}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className={`flex flex-none items-center justify-center ${requested ? 'h-[44px] w-[44px] rounded-[12px] bg-surface text-fg' : 'h-[38px] w-[38px] rounded-md bg-surface-2 text-fg-2'}`}
        >
          <Icon size={requested ? 21 : 18} />
        </span>
        <div className="min-w-[140px] flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <b className={requested ? 'text-[15px]' : 'text-[14px]'}>{p.display_name}</b>
            <IdentityBadge signedIn={p.signed_in} />
          </span>
          <div className={`${requested ? 'text-[13px]' : 'text-[12px]'} text-fg-2`}>
            {p.platform}
            {requested
              ? ` · ${t('web.wants')}`
              : p.joined_via
                ? ` · ${t(p.joined_via === 'code' ? 'product.via_code' : 'product.via_link')}`
                : ''}
          </div>
        </div>
        <span
          className={`inline-flex h-[24px] items-center gap-[5px] rounded-[7px] px-2 text-[12px] font-semibold ${requested ? 'bg-warning-soft text-warning-ink' : 'bg-surface-2 text-fg-2'}`}
        >
          {requested ? <Hourglass aria-hidden size={14} /> : <Check aria-hidden size={14} />}
          {t(requested ? 'web.st.pending' : 'common.queued')}
        </span>
      </div>
      <SecurityWords words={p.security_words} label={t('web_xx.secw_s')} />
      {children}
      <div className="flex flex-wrap gap-2">
        {requested && (
          <>
            <Button
              variant="send"
              className="flex-1"
              icon={Check}
              busy={busy}
              onClick={onApprove}
              aria-label={t('product.approve_named', { name: p.display_name })}
            >
              {t('web.approve')}
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={onReject}
              aria-label={t('product.reject_named', { name: p.display_name })}
            >
              {t('web.reject')}
            </Button>
          </>
        )}
        {!requested && (
          <Button
            variant="ghost"
            size="sm"
            icon={UserX}
            disabled={busy}
            onClick={onRemove}
            aria-label={t('product.remove_confirm', { name: p.display_name })}
          >
            {t('web.remove')}
          </Button>
        )}
        <Button
          variant="danger-ghost"
          size={requested ? 'md' : 'sm'}
          icon={Ban}
          disabled={busy}
          onClick={onBlock}
          aria-label={t('product.block_named', { name: p.display_name })}
        >
          {t('product.block')}
        </Button>
      </div>
    </div>
  );
}
