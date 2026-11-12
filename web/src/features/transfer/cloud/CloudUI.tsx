import { Cloud, CloudUpload, CircleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, ConfirmDialog, Switch } from '../../../components/ui';
import { ApiError } from '../../../lib/api/errors';
import { formatBytes } from '../../../lib/format';
import { useIdentity } from '../../../lib/identity/identity';
import { useI18n } from '../../../i18n/i18n';
import { cloudApi, type CloudEstimate, type CloudSettings } from './api';
import type { CloudUploadState } from './sender';

const GB = 1024 ** 3;

/** Cloud Distribution settings for this device (availability for guests; consent and budget when signed in). */
export function useCloudSettings(): {
  settings: CloudSettings | null;
  failed: boolean;
  reload: () => Promise<void>;
  api: ReturnType<typeof cloudApi>;
} {
  const { client } = useIdentity();
  const api = useMemo(() => cloudApi(client), [client]);
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      setSettings(await api.settings());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { settings, failed, reload, api };
}

function money(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 4 }).format(amount);
  } catch {
    return `${amount.toFixed(4)} ${currency}`;
  }
}

/** What the consent dialog shows: storage, receiver egress (up to five receivers), retention, cost or "cost unknown". */
function EstimateBody({ estimate }: { estimate: CloudEstimate | null }) {
  const { t, locale } = useI18n();
  if (!estimate) return <p className="m-0">{t('product.cloud_estimating')}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="cloud-estimate">
      <p className="m-0">{t('web_xx.cloud_p')}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-fg">
        <li>{t('product.cloud_storage', { size: formatBytes(estimate.storage_bytes, locale) })}</li>
        <li>{t('product.cloud_egress', { size: formatBytes(estimate.egress_bytes, locale) })}</li>
        <li>{t('product.cloud_retention', { hours: estimate.retention_hours })}</li>
        <li data-testid="cloud-cost">
          {estimate.cost === null || estimate.cost === undefined
            ? t('product.cost_unknown')
            : t('product.cloud_cost', { amount: money(estimate.cost, estimate.currency ?? 'USD', locale) })}
        </li>
        <li className="text-fg-2">
          {t('product.cloud_budget_line', {
            used: formatBytes(estimate.used_bytes, locale),
            budget: formatBytes(estimate.budget_bytes, locale),
          })}
        </li>
      </ul>
      {!estimate.within_budget && (
        <p role="alert" className="m-0 flex items-center gap-2 text-danger-ink">
          <CircleAlert aria-hidden size={16} />
          {t('product.cloud_over_budget')}
        </p>
      )}
      <p className="m-0 text-caption">{t('product.cloud_encrypted_p')}</p>
    </div>
  );
}

/**
 * TR-3 Cloud option (docs/UX_SCREEN_MAP.md TR-3, PRD §6.6): hidden when the server has no Cloud; disabled with "Sign in
 * to use Cloud transfer" for guests; for a signed-in sender, turning it on shows the estimate and asks for consent
 * every time, turning Cloud Distribution on in the account (with consent) when needed.
 */
export function CloudSendOption({
  totalBytes,
  value,
  onChange,
}: {
  totalBytes: number;
  value: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const { settings, api, reload } = useCloudSettings();
  const [asking, setAsking] = useState(false);
  const [estimate, setEstimate] = useState<CloudEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!settings?.available) return null;
  if (!settings.signed_in) {
    return (
      <div className="flex items-center gap-3" data-testid="cloud-option">
        <Switch checked={false} onChange={() => undefined} label={t('product.cloud_option')} disabled />
        <span>
          <b className="text-[14px] text-fg-2">{t('product.cloud_option')}</b>
          <span className="block text-[12px] text-fg-2">
            {t('product.cloud_signin')} ·{' '}
            <Link to="/signin?returnTo=%2Fsend" className="font-semibold">
              {t('web.signin')}
            </Link>
          </span>
        </span>
      </div>
    );
  }
  const ask = async (on: boolean) => {
    if (!on) return onChange(false);
    setError(null);
    setEstimate(null);
    setAsking(true);
    try {
      setEstimate(await api.estimate(totalBytes, 5));
    } catch {
      setAsking(false);
      setError(t('product.cloud_unavailable'));
    }
  };
  const approve = async () => {
    setBusy(true);
    try {
      if (!settings.enabled || !settings.consented) await api.putSettings(true, true);
      await reload();
      onChange(true);
      setAsking(false);
    } catch (e) {
      setError(e instanceof ApiError ? t('product.cloud_consent_needed') : t('product.error_generic'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1" data-testid="cloud-option">
      <div className="flex items-center gap-3">
        <Switch checked={value} onChange={(on) => void ask(on)} label={t('product.cloud_option')} />
        <span>
          <b className="text-[14px]">{t('product.cloud_option')}</b>
          <span className="block text-[12px] text-fg-2">{t('product.cloud_option_p')}</span>
        </span>
      </div>
      {error && (
        <span role="alert" className="text-[12px] text-danger-ink">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={asking}
        title={t('web_xx.cloud_h')}
        body={<EstimateBody estimate={estimate} />}
        confirmLabel={t('product.cloud_approve')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        confirmDisabled={!estimate || !estimate.within_budget}
        onConfirm={() => void approve()}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}

/**
 * ST-1 Cloud Distribution row for a signed-in account: availability, the on/off switch (consent the first time), the
 * monthly budget and this month's use.
 */
export function CloudSettingsCard({ rowClass }: { rowClass: string }) {
  const { t, locale } = useI18n();
  const { settings, api, reload, failed } = useCloudSettings();
  const [consenting, setConsenting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [budgetGb, setBudgetGb] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (settings) setBudgetGb(String(Math.round((settings.budget_bytes / GB) * 100) / 100));
  }, [settings]);
  const available = !!settings?.available;
  const save = async (enabled: boolean, consent: boolean, budget?: number) => {
    setBusy(true);
    setError(null);
    try {
      await api.putSettings(enabled, consent, budget);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'invalid_budget' ? t('product.error_generic') : t('product.error_generic'),
      );
    } finally {
      setBusy(false);
    }
  };
  const budgetBytes = Math.round(Number(budgetGb) * GB);
  const budgetValid =
    budgetGb.trim() !== '' &&
    Number.isFinite(budgetBytes) &&
    budgetBytes >= 0 &&
    budgetBytes <= (settings?.max_budget_bytes ?? 0);
  return (
    <div className={`${rowClass} flex-col items-stretch`} data-testid="cloud-settings">
      <div className="flex items-center gap-3">
        <Cloud aria-hidden size={18} className={`flex-none ${available ? 'text-fg-2' : 'text-fg-3'}`} />
        <span className={`flex-1 ${available ? '' : 'text-fg-2'}`}>
          {t('common.s_cloud')}
          <span className="block text-caption text-fg-2">
            {failed || !settings
              ? t('product.cloud_unavailable')
              : available
                ? t('common.s_cloud_p')
                : t('product.cloud_unavailable')}
          </span>
        </span>
        <Switch
          checked={!!settings?.enabled}
          onChange={(on) => (on && !settings?.consented ? setConsenting(true) : void save(on, false))}
          label={t('common.s_cloud')}
          disabled={!available || busy}
        />
      </div>
      {available && settings?.enabled && (
        <div className="flex flex-wrap items-end gap-3 pl-[30px]">
          <label className="flex flex-col gap-1 text-caption text-fg-2">
            {t('product.cloud_budget')} (GB)
            <input
              type="number"
              min={0}
              step="0.5"
              inputMode="decimal"
              value={budgetGb}
              onChange={(e) => setBudgetGb(e.target.value)}
              className="min-h-touch w-[120px] rounded-md border border-border-strong bg-surface px-3 text-[14px] text-fg"
              data-testid="cloud-budget"
            />
          </label>
          <Button
            variant="secondary"
            disabled={!budgetValid || busy}
            onClick={() => void save(true, false, budgetBytes)}
          >
            {t('product.cloud_budget_save')}
          </Button>
          <span className="text-caption text-fg-2" data-testid="cloud-usage">
            {t('product.cloud_budget_used', {
              used: formatBytes(settings.used_bytes, locale),
              budget: formatBytes(settings.budget_bytes, locale),
            })}
          </span>
        </div>
      )}
      {error && (
        <span role="alert" className="pl-[30px] text-caption text-danger-ink">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={consenting}
        title={t('web_xx.cloud_h')}
        body={
          <div className="flex flex-col gap-2">
            <p className="m-0">{t('product.cloud_consent_settings_p')}</p>
            <p className="m-0 text-caption">{t('product.cloud_encrypted_p')}</p>
          </div>
        }
        confirmLabel={t('product.cloud_approve')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        onConfirm={() => void save(true, true).then(() => setConsenting(false))}
        onCancel={() => setConsenting(false)}
      />
    </div>
  );
}

/** The sender's Cloud upload on the session screen: per-file progress, ready, paused or failed (with the reason). */
export function CloudUploadCard({ state }: { state: CloudUploadState }) {
  const { t, locale } = useI18n();
  const total = state.files.reduce((a, f) => a + f.size, 0);
  const done = state.files.reduce((a, f) => a + f.uploaded, 0);
  const ready = state.files.length > 0 && state.files.every((f) => f.status === 'ready');
  const paused = state.files.some((f) => f.status === 'paused');
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="cloud-upload"
      data-cloud-state={ready ? 'ready' : paused ? 'paused' : 'uploading'}
    >
      <div className="flex items-center gap-2 text-[14px] font-semibold">
        <CloudUpload aria-hidden size={18} className="text-send-ink" />
        {ready
          ? t('product.cloud_ready')
          : paused
            ? t('product.cloud_paused')
            : t('product.cloud_uploading', { done: formatBytes(done, locale), total: formatBytes(total, locale) })}
      </div>
      {!ready && (
        <div
          role="progressbar"
          aria-label={t('product.cloud_option')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={total ? Math.round((done / total) * 100) : 0}
          className="h-[6px] overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full bg-send" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      )}
      {state.error && <Banner tone="warning" title={t(state.error)} />}
    </div>
  );
}
