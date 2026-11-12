import {
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  CircleCheck,
  Cloud,
  CircleDashed,
  CircleX,
  Clock,
  Loader,
  Pause,
  RefreshCw,
  RadioTower,
  ShieldCheck,
  UserX,
  WifiOff,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18n';
import { formatBytes } from '../../lib/format';
import type { RouteKind } from './engine/route';
import type { Route } from './runtime/api';
import type { LogLine } from './runtime/receiver-controller';

/** Status chip states shared by the sender dashboard and the receive screens (design `chip` table). */
export type ChipState =
  | 'waiting'
  | 'offline'
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
  | 'removed'
  | 'blocked';

const CHIP: Record<ChipState, { cls: string; icon: LucideIcon; key: string }> = {
  waiting: { cls: 'bg-surface-2 text-fg-2', icon: Clock, key: 'product.st_waiting' },
  offline: { cls: 'bg-warning-soft text-warning-ink', icon: WifiOff, key: 'product.st_offline' },
  connecting: { cls: 'bg-surface-2 text-fg-2', icon: Loader, key: 'web.st.connecting' },
  transferring: { cls: 'bg-send-soft text-send-ink', icon: ArrowUpRight, key: 'web.st.transferring' },
  receiving: { cls: 'bg-send-soft text-send-ink', icon: ArrowDownLeft, key: 'web.st.receiving' },
  paused: { cls: 'bg-surface-2 text-fg-2', icon: Pause, key: 'web.st.paused' },
  reconnecting: { cls: 'bg-warning-soft text-warning-ink', icon: RefreshCw, key: 'web.st.reconnecting' },
  verifying: { cls: 'bg-send-soft text-send-ink', icon: ShieldCheck, key: 'web.st.verifying' },
  completed: { cls: 'bg-receive-soft text-receive-ink', icon: CircleCheck, key: 'web.st.completed' },
  partial: { cls: 'bg-warning-soft text-warning-ink', icon: CircleDashed, key: 'web.st.partial' },
  failed: { cls: 'bg-danger-soft text-danger-ink', icon: CircleX, key: 'web.st.failed' },
  cancelled: { cls: 'bg-surface-2 text-fg-2', icon: Ban, key: 'web.st.cancelled' },
  removed: { cls: 'bg-surface-2 text-fg-2', icon: UserX, key: 'web.st.removed' },
  blocked: { cls: 'bg-surface-2 text-fg-2', icon: Ban, key: 'phrases.blocked' },
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

/**
 * Route badge as in the Design System: Direct (P2P, green, zap), Relay (TURN, blue, radio tower) or Cloud (store and
 * forward, blue, cloud); never color-only.
 */
export function RouteChip({ route, kind }: { route: Route | null; kind?: RouteKind | null }) {
  const { t } = useI18n();
  if (!route) return null;
  const direct = route === 'direct';
  return (
    <span
      data-testid="route-chip"
      data-route={route}
      {...(kind ? { 'data-route-kind': kind } : {})}
      className={`inline-flex h-[26px] items-center gap-[6px] rounded-full px-[10px] text-[12px] font-semibold ${direct ? 'bg-receive-soft text-receive-ink' : 'bg-send-soft text-send-ink'}`}
    >
      {direct ? (
        <Zap aria-hidden size={14} />
      ) : route === 'cloud' ? (
        <Cloud aria-hidden size={14} />
      ) : (
        <RadioTower aria-hidden size={14} />
      )}
      {t(direct ? 'handoff.p2p' : route === 'cloud' ? 'product.route_cloud' : 'handoff.relay')}
    </span>
  );
}

export type BarTone = 'send' | 'receive' | 'warning' | 'danger' | 'muted';

/** Progress bar color per state, as in the design (Web App `BAR`): grey when paused, green when verifying. */
export function barTone(state: string): BarTone {
  if (state === 'paused' || state === 'cancelled' || state === 'removed' || state === 'blocked' || state === 'offline')
    return 'muted';
  if (state === 'verifying' || state === 'completed') return 'receive';
  if (state === 'reconnecting') return 'warning';
  if (state === 'failed') return 'danger';
  return 'send';
}

export function ProgressBar({
  value,
  label,
  tone = 'send',
  height = 8,
}: {
  value: number;
  label: string;
  tone?: BarTone;
  height?: 4 | 8 | 10;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 1000) / 10));
  const fill = { send: 'bg-send', receive: 'bg-receive', warning: 'bg-warning', danger: 'bg-danger', muted: 'bg-fg-3' }[
    tone
  ];
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
    const time =
      m >= 60
        ? t('product.eta_hm', { h: Math.floor(m / 60), m: m % 60 })
        : m > 0
          ? t('product.eta_ms', { m, s })
          : t('product.eta_s', { s });
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
