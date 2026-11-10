import { Eye, MonitorCheck, Sun, SunDim } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/i18n';
import { useKeepAwakeController } from '../lib/keepAwake/KeepAwakeContext';
import type { PillState } from '../lib/keepAwake/controller';

const LABEL: Record<PillState, string> = {
  on: 'web_xx.wake_on',
  off: 'web_xx.wake_off',
  paused: 'web_xx.wake_paused',
  setoff: 'web_xx.wake_setoff',
  unsupported: 'web_xx.wake_unsup',
  refused: 'product.wake_refused',
};

/**
 * Sticky keep-open banner with the screen-on pill (docs/ARCHITECTURE.md §7.3, DESIGN_SYSTEM ScreenOnPill).
 * Shown on every send, receive, and waiting screen.
 */
export function KeepOpenBanner({ state }: { state: PillState }) {
  const { t } = useI18n();
  const controller = useKeepAwakeController();
  const navigate = useNavigate();
  const warn = state === 'unsupported' || state === 'refused';
  const interactive = state !== 'paused' && state !== 'unsupported';
  const Icon = warn ? Eye : state === 'on' ? Sun : SunDim;
  return (
    <div
      role="status"
      data-testid="keep-open-banner"
      className="sticky top-[72px] z-[5] flex flex-wrap items-center gap-3 rounded-[12px] border border-border bg-send-soft px-4 py-3 text-[14px] leading-[1.45] text-fg"
    >
      <MonitorCheck aria-hidden size={20} className="flex-none text-send-ink" />
      <span className="min-w-[180px] flex-1">
        <b>{t('web.keep')}</b>
        <span className="block text-caption text-fg-2">{t('web.keep_sub')}</span>
      </span>
      <button
        type="button"
        data-testid="screen-on-pill"
        data-state={state}
        aria-pressed={state === 'on'}
        aria-disabled={!interactive || undefined}
        onClick={() => {
          if (!interactive) return;
          if (controller.tap() === 'setting') navigate('/settings');
        }}
        className={`inline-flex min-h-touch flex-none items-center gap-[6px] rounded-full border px-3 text-caption font-semibold ${
          warn
            ? 'border-transparent bg-warning-soft text-warning-ink'
            : state === 'on'
              ? 'border-send bg-surface text-send-ink'
              : 'border-border-strong bg-surface text-fg-2'
        } ${interactive ? '' : 'cursor-default'}`}
      >
        <Icon aria-hidden size={16} />
        {t(LABEL[state])}
      </button>
    </div>
  );
}
