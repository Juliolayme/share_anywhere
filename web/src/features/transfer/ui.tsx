import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Loader,
  Pause,
  RefreshCw,
  Radio,
  ShieldCheck,
  UserX,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18n';
import { formatBytes } from '../../lib/format';
import type { Route } from './runtime/api';
import type { LogLine } from './runtime/receiver-controller';

/** Status chip states shared by the sender dashboard and the receive screens (design `chip` table). */
export type ChipState =
  | 'waiting'
  | 'connecting'
  | 'transferring'
  | 'receiving'
  | 'paused'
  | 'reconnecting'
  | 'verifying'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'removed';

const CHIP: Record<ChipState, { cls: string; icon: LucideIcon; key: string }> = {
  waiting: { cls: 'bg-surface-2 text-fg-2', icon: Clock, key: 'web.st.pending' },
  connecting: { cls: 'bg-send-soft text-send-ink', icon: Loader, key: 'web.st.connecting' },
  transferring: { cls: 'bg-send-soft text-send-ink', icon: Radio, key: 'web.st.transferring' },
  receiving: { cls: 'bg-send-soft text-send-ink', icon: Radio, key: 'web.st.receiving' },
  paused: { cls: 'bg-surface-2 text-fg-2', icon: Pause, key: 'web.st.paused' },
  reconnecting: { cls: 'bg-warning-soft text-warning-ink', icon: RefreshCw, key: 'web.st.reconnecting' },
  verifying: { cls: 'bg-send-soft text-send-ink', icon: ShieldCheck, key: 'web.st.verifying' },
  completed: { cls: 'bg-receive-soft text-receive-ink', icon: CircleCheck, key: 'web.st.completed' },
  partial: { cls: 'bg-warning-soft text-warning-ink', icon: CircleAlert, key: 'web.st.partial' },
  failed: { cls: 'bg-danger-soft text-danger-ink', icon: CircleX, key: 'web.st.failed' },
  cancelled: { cls: 'bg-surface-2 text-fg-2', icon: Ban, key: 'web.st.cancelled' },
  removed: { cls: 'bg-surface-2 text-fg-2', icon: UserX, key: 'web.st.removed' },
};

export function TransferChip({ state }: { state: ChipState }) {
  const { t } = useI18n();
  const { cls, icon: Icon, key } = CHIP[state];
  return (
    <span
      data-testid="transfer-status"
      data-state={state}
      className={`inline-flex h-[26px] flex-none items-center gap-[5px] rounded-[8px] px-[9px] text-[12px] font-semibold ${cls}`}
    >
      <Icon
        aria-hidden
        size={14}
        className={state === 'reconnecting' ? 'animate-spin motion-reduce:animate-none' : ''}
      />
      {t(key)}
    </span>
  );
}

/** Route badge: Direct (P2P) or Relay (TURN), never color-only. */
export function RouteChip({ route }: { route: Route | null }) {
  const { t } = useI18n();
  if (!route) return null;
  const direct = route === 'direct';
  return (
    <span
      data-testid="route-chip"
      data-route={route}
      className={`inline-flex h-[24px] items-center gap-[5px] rounded-full px-[9px] text-[12px] font-semibold ${direct ? 'bg-receive-soft text-receive-ink' : 'bg-cloud-soft text-cloud-ink'}`}
    >
      {direct ? <Zap aria-hidden size={14} /> : <Radio aria-hidden size={14} />}
      {t(direct ? 'handoff.p2p' : 'handoff.relay')}
    </span>
  );
}

export function ProgressBar({
  value,
  label,
  tone = 'send',
  height = 8,
}: {
  value: number;
  label: string;
  tone?: 'send' | 'receive' | 'warning' | 'danger';
  height?: 4 | 8 | 10;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 1000) / 10));
  const fill = { send: 'bg-send', receive: 'bg-receive', warning: 'bg-warning', danger: 'bg-danger' }[tone];
  const h = { 4: 'h-[4px]', 8: 'h-[8px]', 10: 'h-[10px]' }[height];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={`${h} overflow-hidden rounded-full bg-track`}
    >
      <div
        className={`h-full rounded-full ${fill} transition-[width] duration-base motion-reduce:transition-none`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function percent(done: number, total: number): string {
  if (total <= 0) return '100%';
  return `${Math.floor((done / total) * 100)}%`;
}

/** "Estimating time…" while provisional, else "4 min left" style text. */
export function useEta() {
  const { t } = useI18n();
  return (seconds: number | null) => {
    if (seconds === null) return t('web.estimating');
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    const time = m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m > 0 ? `${m} min ${s} s` : `${s} s`;
    return t('product.eta_left', { time });
  };
}

export function useSpeed() {
  const { t, locale } = useI18n();
  return (bytesPerSecond: number) =>
    bytesPerSecond > 0 ? t('product.per_second', { size: formatBytes(bytesPerSecond, locale) }) : '—';
}

/** The connection log shown by Details (design: drawer on desktop, sheet on mobile). */
export function ConnectionLog({ lines }: { lines: LogLine[] }) {
  const { t } = useI18n();
  return (
    <section aria-label={t('product.log_title')} className="flex flex-col gap-2 rounded-[12px] bg-surface-2 p-3">
      <h3 className="m-0 text-[13px] font-semibold">{t('product.log_title')}</h3>
      {lines.length === 0 ? (
        <p className="m-0 text-[13px] text-fg-2">{t('product.log_empty')}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0" data-testid="connection-log">
          {lines.map((l, i) => (
            <li key={i} className="flex gap-2 font-mono text-[12px] text-fg-2">
              <time dateTime={new Date(l.at).toISOString()}>
                {new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </time>
              <span className="text-fg">{t(l.key, l.params)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
