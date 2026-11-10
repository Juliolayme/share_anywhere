import { Trash2, User } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ConfirmDialog, Segmented, Screen } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n, type Locale } from '../i18n/i18n';
import { useIdentity } from '../lib/identity/identity';
import { useTheme } from '../lib/theme';
import { useRetention } from '../lib/prefs';
import { useHistory } from '../features/history/HistoryContext';
import type { Retention } from '../features/history/store/history-store';

const VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-[20px]">
      <h2 className="m-0 text-[16px]">{title}</h2>
      {children}
    </Card>
  );
}

/**
 * ST-1 / design screen `settings`, guest view with the sections that work in Phase 1. Transfer,
 * notification, data and clipboard sections arrive with the features they control.
 */
export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const toast = useToast();
  const { device } = useIdentity();
  const { refresh, clear, entries, error } = useHistory();
  const theme = useTheme();
  const [retention, setRetention] = useRetention();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Screen id="settings">
      <h1 className="m-0 text-[clamp(26px,3vw,32px)] font-bold tracking-[-0.025em]">{t('web.st_h')}</h1>
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
        <Section title={t('web_vv.k42')}>
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className="flex h-[44px] w-[44px] items-center justify-center rounded-full bg-surface-2 text-fg-2"
            >
              <User size={20} />
            </span>
            <div className="min-w-[160px] flex-1">
              <b data-testid="identity-label">{t('web.guest')}</b>
              <div className="text-caption text-fg-2">{t('product.no_account')}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-[14px]">
            <span className="text-fg-2">{t('web_vv.k17')}</span>
            <span className="flex items-center gap-2">
              <b data-testid="settings-device-name">{device?.display_name ?? t('product.identity_loading')}</b>
              <Link to="/devices" className="text-caption font-semibold">
                {t('web_vv.k76')}
              </Link>
            </span>
          </div>
        </Section>
        <Section title={t('web_vv.k49')}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[14px]">{t('web_vv.k50')}</span>
            <Segmented
              label={t('web_vv.k50')}
              value={theme.preference}
              onChange={theme.set}
              options={[
                { value: 'system', label: t('common.th_sys') },
                { value: 'light', label: t('common.th_light') },
                { value: 'dark', label: t('common.th_dark') },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[14px]">{t('web_vv.k51')}</span>
            <Segmented<Locale>
              label={t('web_vv.k51')}
              value={locale}
              onChange={setLocale}
              options={[
                { value: 'en', label: t('product.lang_en') },
                { value: 'vi', label: t('product.lang_vi') },
              ]}
            />
          </div>
        </Section>
        <Section title={t('web_vv.k69')}>
          <label className="flex flex-wrap items-center justify-between gap-3 text-[14px]">
            {t('web_vv.k70')}
            <select
              value={retention}
              onChange={async (e) => {
                setRetention(e.target.value as Retention);
                await refresh();
              }}
              className="h-[40px] rounded-md border border-border-strong bg-surface px-[10px] text-[14px] text-fg"
            >
              <option value="30">{t('web_vv.k71')}</option>
              <option value="90">{t('web_vv.k72')}</option>
              <option value="none">{t('web_vv.k73')}</option>
            </select>
          </label>
          <div className="flex justify-start">
            <Button
              variant="danger-ghost"
              icon={Trash2}
              disabled={entries.length === 0}
              onClick={() => setConfirm(true)}
            >
              {t('web.clear')}
            </Button>
          </div>
          <p className="m-0 text-caption leading-[1.5] text-fg-2">{t('web_vv.k74')}</p>
          <div className="flex justify-between border-t border-border pt-[10px] text-caption text-fg-2">
            <span>{t('product.version_web', { version: VERSION })}</span>
          </div>
        </Section>
      </div>
      <ConfirmDialog
        open={confirm}
        title={t('common.hc_h')}
        body={t('common.hc_p')}
        confirmLabel={t('web.clear')}
        cancelLabel={t('common.cancel')}
        danger
        onCancel={() => setConfirm(false)}
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await clear();
            toast.show(t('common.n_cleared'));
          } catch {
            toast.show(t(error ? 'product.history_unavailable' : 'product.clear_failed'));
          } finally {
            setBusy(false);
            setConfirm(false);
          }
        }}
      />
    </Screen>
  );
}
