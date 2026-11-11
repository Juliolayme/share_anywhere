import { ArrowLeft, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, Card, ConfirmDialog, PageHeader, Screen, Switch } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n/i18n';
import { useAccount } from '../features/account/AccountContext';
import { useClipboard, useClipboardState } from '../features/clipboard/ClipboardContext';
import { useAutoCapture } from '../features/clipboard/prefs';
import type { ClipboardSettings } from '../features/clipboard/api';

const RETENTION = [7, 3, 1] as const;

function Row({ label, sub, children }: { label: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="min-w-0 flex-1">
        <span className="text-[14px]">{label}</span>
        {sub && <div className="text-caption leading-[1.5] text-fg-2">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * CB-6 `/settings/clipboard`: retention for new items, pause sync, sensitive-content handling (account-wide,
 * `PUT /v1/clipboard/settings`), automatic capture on this browser, and clear history. A guest, or a device that is not
 * ready for Clipboard Sync, sees the controls disabled with the way forward; nothing here reads the clipboard.
 */
export default function ClipboardSettingsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const account = useAccount();
  const clipboard = useClipboard();
  const state = useClipboardState(clipboard.runtime);
  const [auto, setAuto] = useAutoCapture();
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const runtime = clipboard.runtime;
  const settings = state?.snapshot.settings ?? null;
  const ready = runtime !== null && settings !== null;
  const guest = account.phase === 'guest';

  const save = async (patch: Partial<ClipboardSettings>) => {
    if (!runtime || !settings) return;
    setSaving(true);
    try {
      await runtime.engine.saveSettings({ ...settings, ...patch });
    } catch {
      toast.show(t('product.cb_settings_failed'));
    } finally {
      setSaving(false);
    }
  };

  const keepLabel = (n: number) =>
    n === 7 ? t('web_vv.k66') : n === 1 ? t('product.cb_keep_1') : t('product.cb_keep_days', { n });

  return (
    <Screen id="clipboard-settings">
      <Link
        to={guest ? '/settings' : '/clipboard'}
        className="inline-flex items-center gap-2 self-start text-caption font-semibold"
      >
        <ArrowLeft aria-hidden size={16} />
        {guest ? t('web.st_h') : t('product.cb_back')}
      </Link>
      <PageHeader
        title={t('product.cb_settings_link')}
        subtitle={<p className="m-0">{t('product.cb_settings_p')}</p>}
      />
      {guest ? (
        <Banner
          tone="info"
          action={
            <Link to="/signin?returnTo=%2Fsettings%2Fclipboard" className="whitespace-nowrap font-semibold">
              {t('web.signin')}
            </Link>
          }
        >
          {t('common.s_guest_p')}
        </Banner>
      ) : (
        !ready &&
        (state?.snapshot.settingsError ? (
          <Banner
            tone="danger"
            role="alert"
            action={
              <Button size="sm" onClick={() => void runtime?.engine.loadSettings()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t('product.cb_settings_load_failed')}
          </Banner>
        ) : runtime ? (
          <div role="status" aria-busy="true" className="sr-only">
            {t('product.cb_loading')}
          </div>
        ) : (
          <Banner
            tone="info"
            action={
              <Link to="/clipboard" className="whitespace-nowrap font-semibold">
                {t('web.cb_h')}
              </Link>
            }
          >
            {t('product.add_device_clipboard')}
          </Banner>
        ))
      )}
      <Card className="flex flex-col gap-4 p-[20px]">
        <Row label={t('web_vv.k61')} sub={t('web_vv.k62')}>
          <Switch checked={!guest && auto} onChange={setAuto} label={t('web_vv.k61')} disabled={!ready} />
        </Row>
        <Row
          label={t('web_vv.k63')}
          sub={
            <>
              {t('web_vv.k64')} {t('product.cb_skip_disclaimer')}
            </>
          }
        >
          <Switch
            checked={settings?.sensitive_skip ?? true}
            onChange={(v) => void save({ sensitive_skip: v })}
            label={t('web_vv.k63')}
            disabled={!ready || saving}
          />
        </Row>
        <Row label={t('product.cb_pause_label')} sub={t('product.cb_pause_p')}>
          <Switch
            checked={settings?.paused ?? false}
            onChange={(v) => void save({ paused: v })}
            label={t('product.cb_pause_label')}
            disabled={!ready || saving}
          />
        </Row>
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <label className="flex flex-wrap items-center justify-between gap-3 text-[14px]">
            {t('web_vv.k65')}
            <select
              value={settings?.retention_days ?? 7}
              disabled={!ready || saving}
              onChange={(e) => void save({ retention_days: Number(e.target.value) })}
              className="h-[40px] rounded-md border border-border-strong bg-surface px-[10px] text-[14px] text-fg disabled:opacity-50"
            >
              {[...new Set([...RETENTION, settings?.retention_days ?? 7])].map((n) => (
                <option key={n} value={n}>
                  {keepLabel(n)}
                </option>
              ))}
            </select>
          </label>
          <span className="text-caption text-fg-2">{t('product.cb_retention_p')}</span>
        </div>
        <div className="border-t border-border pt-3">
          <Button
            variant="danger-ghost"
            icon={Trash2}
            disabled={!ready || (state?.snapshot.items.length ?? 0) === 0}
            onClick={() => setConfirmClear(true)}
          >
            {t('common.cb_clear')}
          </Button>
        </div>
      </Card>
      <ConfirmDialog
        open={confirmClear}
        title={t('common.cbc_h')}
        body={t('common.cbc_p')}
        confirmLabel={t('common.cb_clear')}
        cancelLabel={t('common.cancel')}
        danger
        busy={clearing}
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          if (!runtime) return;
          setClearing(true);
          try {
            await runtime.engine.clear();
            toast.show(t('common.n_cbcleared'));
          } catch {
            toast.show(t('product.cb_clear_failed'));
          } finally {
            setClearing(false);
            setConfirmClear(false);
          }
        }}
      />
    </Screen>
  );
}
