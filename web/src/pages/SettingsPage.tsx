import { Cloud, History, MonitorSmartphone, Trash2, User } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ConfirmDialog, Segmented, Screen, Switch } from '../components/ui';
import { useAccount } from '../features/account/AccountContext';
import { useKeepScreenOnSetting } from '../lib/keepAwake/KeepAwakeContext';
import { useToast } from '../components/Toast';
import { useI18n, type Locale } from '../i18n/i18n';
import { useIdentity } from '../lib/identity/identity';
import { useTheme } from '../lib/theme';
import { useRetention } from '../lib/prefs';
import { useHistory } from '../features/history/HistoryContext';
import type { Retention } from '../features/history/store/history-store';

const VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';
// The signed-in account section (history sync, devices, password, sign out) loads only for signed-in users.
const AccountSettings = lazy(() => import('../features/account/AccountSettings'));

const linkBtn =
  'inline-flex h-[42px] items-center justify-center rounded-md px-4 text-[14px] font-semibold no-underline';

/** ST-1 guest header (design `settings` guest): Sign in and Create account, both returning to Settings. */
function GuestAccount() {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        to="/signin?returnTo=%2Fsettings"
        className={`${linkBtn} bg-send text-on-send hover:bg-send-hover hover:text-on-send`}
      >
        {t('web.signin')}
      </Link>
      <Link
        to="/signup?returnTo=%2Fsettings"
        className={`${linkBtn} border border-border-strong bg-surface text-fg hover:bg-surface-2 hover:text-fg`}
      >
        {t('web.create_acc')}
      </Link>
    </div>
  );
}

/** Account-only settings shown disabled for guests, with the reason (PRD §5.8). */
function GuestAccountFeatures() {
  const { t } = useI18n();
  const rows = [
    { icon: History, label: t('product.history_sync') },
    { icon: MonitorSmartphone, label: t('product.manage_devices') },
    { icon: Cloud, label: t('common.s_cloud'), note: t('product.cloud_signin') },
  ];
  return (
    <Section title={t('common.g_account')}>
      <p className="m-0 text-caption leading-[1.5] text-fg-2">{t('product.account_guest_p')}</p>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3 border-t border-border pt-3 text-[14px]">
          <r.icon aria-hidden size={18} className="flex-none text-fg-3" />
          <span className="flex-1 text-fg-2">
            {r.label}
            {r.note && <span className="block text-caption">{r.note}</span>}
          </span>
          <Switch checked={false} onChange={() => undefined} label={r.label} disabled />
        </div>
      ))}
      <Link to="/signin?returnTo=%2Fsettings" className="self-start text-caption font-semibold">
        {t('web.signin')}
      </Link>
    </Section>
  );
}

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
  const account = useAccount();
  const signedIn = account.phase === 'signed_in';
  const { refresh, clear, entries, error } = useHistory();
  const theme = useTheme();
  const [keepOn, setKeepOn] = useKeepScreenOnSetting();
  const [retention, setRetention] = useRetention();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Screen id="settings">
      <h1 className="m-0 text-[clamp(26px,3vw,32px)] font-bold tracking-[-0.025em]">{t('web.st_h')}</h1>
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
        <Section title={t('web_vv.k42')}>
          {signedIn ? (
            <Suspense fallback={<div aria-hidden className="h-[120px] animate-pulse rounded-md bg-surface-2" />}>
              <AccountSettings />
            </Suspense>
          ) : (
            <>
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
              {account.enabled && <GuestAccount />}
            </>
          )}
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
        {account.enabled && !signedIn && <GuestAccountFeatures />}
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
        <Section title={t('web_vv.k58')}>
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[14px]">
              {t('web_xx.wake_set')}
              <span className="block text-caption text-fg-2">{t('web_xx.wake_set_p')}</span>
            </span>
            <Switch checked={keepOn} onChange={setKeepOn} label={t('web_xx.wake_set')} />
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
        body={
          account.added && account.me?.history_sync
            ? `${t('common.hc_p')} ${t('product.history_clear_synced')}`
            : t('common.hc_p')
        }
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
