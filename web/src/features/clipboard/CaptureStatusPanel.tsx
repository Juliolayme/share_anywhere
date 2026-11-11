import { CircleAlert, CircleCheck, Info, Lock, Pause, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n/i18n';
import { Switch } from '../../components/ui';
import type { CaptureStatus } from './status';

const LOOK: Record<CaptureStatus, { cls: string; ink: string; icon: LucideIcon }> = {
  auto: { cls: 'bg-receive-soft', ink: 'text-receive-ink', icon: CircleCheck },
  besteffort: { cls: 'bg-send-soft', ink: 'text-send-ink', icon: Info },
  denied: { cls: 'bg-danger-soft', ink: 'text-danger-ink', icon: CircleAlert },
  unsupported: { cls: 'bg-warning-soft', ink: 'text-warning-ink', icon: TriangleAlert },
  offline: { cls: 'bg-warning-soft', ink: 'text-warning-ink', icon: WifiOff },
  paused: { cls: 'bg-surface-2', ink: 'text-fg-2', icon: Pause },
  insecure: { cls: 'bg-danger-soft', ink: 'text-danger-ink', icon: Lock },
};

/**
 * CB-4 capture status panel (design `clipboard`, `clipboardStatus` states): says plainly whether capture is automatic,
 * best-effort or manual on this browser, why, and what to do; Pause / Resume (account-wide) and the per-browser
 * automatic capture switch.
 */
export function CaptureStatusPanel({
  status,
  autoCapture,
  queued,
  busy,
  onAutoCapture,
  onPause,
}: {
  status: CaptureStatus;
  autoCapture: boolean;
  queued: number;
  busy: boolean;
  onAutoCapture: (on: boolean) => void;
  onPause: (paused: boolean) => void;
}) {
  const { t } = useI18n();
  const look = LOOK[status];
  const offlineTitle =
    queued === 0
      ? t('common.off_h')
      : queued === 1
        ? t('product.cb_offline_1')
        : t('product.cb_offline_n', { n: queued });
  const [title, sub] = {
    auto: [
      t('phrases.automatic_capture_is_on'),
      t('phrases.share_anywhere_reads_your_clipboard_when_this_tab_is_focused'),
    ],
    besteffort: autoCapture
      ? [
          t('phrases.automatic_capture_is_best_effort'),
          t('phrases.automatic_capture_is_available_when_your_browser_permits_it_'),
        ]
      : [t('product.cb_auto_off_h'), t('product.cb_auto_off_p')],
    denied: [
      t('phrases.clipboard_permission_denied'),
      t('phrases.allow_clipboard_access_in_your_browser_s_site_settings_lock_'),
    ],
    unsupported: [
      t('phrases.this_browser_can_t_read_the_clipboard_automatically'),
      t('phrases.firefox_and_some_mobile_browsers_block_background_reads_clic'),
    ],
    offline: [offlineTitle, t('phrases.items_are_encrypted_and_queued_on_this_device_they_ll_sync_w')],
    paused: [t('phrases.sync_is_paused'), t('phrases.nothing_is_read_or_sent_until_you_resume')],
    insecure: [t('product.cb_https_h'), t('product.cb_https_p')],
  }[status];
  const Icon = look.icon;
  return (
    <div
      data-testid="cb-status"
      data-status={status}
      className={`flex items-start gap-3 rounded-lg px-4 py-[14px] ${look.cls}`}
    >
      <Icon aria-hidden size={20} className={`mt-[1px] flex-none ${look.ink}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <b role="status" data-testid="cb-status-title" className={`text-[14px] ${look.ink}`}>
          {title}
        </b>
        <span className="text-caption leading-[1.5] text-fg">{sub}</span>
        {(status === 'denied' || status === 'unsupported') && (
          <span className="text-caption leading-[1.5] text-fg">{t('product.clipboard_click_sync')}</span>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {status === 'paused' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onPause(false)}
              className="inline-flex h-[34px] min-h-touch items-center rounded-sm bg-send px-3 rail:min-h-0 text-caption font-semibold text-on-send hover:bg-send-hover disabled:opacity-50"
            >
              {t('product.cb_resume')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onPause(true)}
              className="inline-flex h-[34px] min-h-touch items-center gap-[6px] rounded-sm px-[10px] rail:min-h-0 text-caption font-semibold text-fg-2 hover:bg-surface disabled:opacity-50"
            >
              <Pause aria-hidden size={14} />
              {t('product.cb_pause')}
            </button>
          )}
          <span className="flex items-center gap-2 text-caption text-fg">
            <Switch checked={autoCapture} onChange={onAutoCapture} label={t('web_vv.k61')} />
            <span aria-hidden>{t('web_vv.k61')}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
