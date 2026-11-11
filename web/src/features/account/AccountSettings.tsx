import { ChevronRight, Cloud, History, KeyRound, LogOut, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, ConfirmDialog, Segmented, Switch } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { FormError, PasswordField } from '../../pages/account/AuthLayout';
import { accountErrorText, useAccount } from './AccountContext';
import { KeyProblemBanner } from './KeyProblem';
import { MAX_PASSWORD, MIN_PASSWORD } from './state';

const row = 'flex min-h-[48px] items-center gap-3 border-t border-border py-2 text-[14px]';

function ChangePassword({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const account = useAccount();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!current) errs.current = t('product.password_required');
    if (next.length < MIN_PASSWORD) errs.next = t('product.password_short');
    if (confirm !== next) errs.confirm = t('product.password_mismatch');
    setErrors(errs);
    if (errs.current || errs.next || errs.confirm) return;
    setBusy(true);
    try {
      await account.changePassword(current, next);
      toast.show(t('common.cp_done'));
      onClose();
    } catch (err) {
      setErrors(
        err instanceof ApiError && err.code === 'invalid_credentials'
          ? { current: t('product.chpw_wrong') }
          : { form: accountErrorText(err, t) },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3 border-t border-border pt-3">
      <PasswordField
        label={t('common.cp_cur')}
        autoComplete="current-password"
        value={current}
        onChange={setCurrent}
        error={errors.current ?? null}
        maxLength={MAX_PASSWORD}
      />
      <PasswordField
        label={t('common.cp_new')}
        autoComplete="new-password"
        value={next}
        onChange={setNext}
        error={errors.next ?? null}
        hint={t('product.password_hint')}
        maxLength={MAX_PASSWORD}
      />
      <PasswordField
        label={t('common.cp_conf')}
        autoComplete="new-password"
        value={confirm}
        onChange={setConfirm}
        error={errors.confirm ?? null}
        maxLength={MAX_PASSWORD}
      />
      <p className="m-0 text-caption text-fg-2">{t('product.chpw_note')}</p>
      {errors.form && <FormError>{errors.form}</FormError>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="send" busy={busy}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function KeyRow() {
  const { t } = useI18n();
  const account = useAccount();
  const k = account.keys;
  if (k === 'rejected' || k === 'legacy') {
    return (
      <div className="border-t border-border py-3" data-testid="key-status">
        <KeyProblemBanner status={k} returnTo="/settings" />
      </div>
    );
  }
  return (
    <div className={row} data-testid="key-status">
      <KeyRound aria-hidden size={18} className="flex-none text-fg-2" />
      <span className="flex-1">
        {k === 'ready'
          ? t('product.key_ready')
          : k === 'pair'
            ? t('product.history_sync_needs_key')
            : k === 'setup'
              ? t('product.ck_no_key')
              : k === 'unavailable'
                ? t('product.keys_unavailable')
                : k === 'error'
                  ? t('product.keys_error')
                  : t('product.keys_checking')}
      </span>
      {k === 'ready' && <ShieldCheck aria-hidden size={18} className="text-receive-ink" />}
      {(k === 'pair' || k === 'setup') && (
        <Link
          to={`${k === 'pair' ? '/account/key/pair' : '/account/key/setup'}?returnTo=%2Fsettings`}
          className="text-caption font-semibold"
        >
          {k === 'pair' ? t('product.pair_h') : t('product.key_setup_cta')}
        </Link>
      )}
      {k === 'error' && (
        <Button size="sm" onClick={() => void account.refreshKeys()}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

/**
 * ST-1 signed-in account section (design `settings` signed in): account email, add this device, history sync
 * (`PATCH /v1/me`), encryption key state, Manage devices, Change password, Cloud (Phase 8), Sign out (AC-7).
 */
export default function AccountSettings() {
  const { t } = useI18n();
  const toast = useToast();
  const account = useAccount();
  const [pw, setPw] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [keep, setKeep] = useState<'keep' | 'clear'>('keep');
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const email = account.me?.email ?? '';
  const syncOn = account.me?.history_sync === true;

  const toggleSync = async (on: boolean) => {
    setSyncBusy(true);
    try {
      await account.setHistorySync(on);
      if (on) void account.syncNow();
    } catch {
      toast.show(t('product.history_sync_failed_toggle'));
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 pb-3">
        <span
          aria-hidden
          className="flex h-[44px] w-[44px] flex-none items-center justify-center rounded-full bg-send font-bold text-on-send"
        >
          {(email[0] ?? '?').toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate" data-testid="identity-label">
            {email || t('product.badge_signed_in')}
          </b>
          <div className="text-caption text-fg-2">
            {account.added ? t('product.badge_signed_in') : t('product.ck_not_added')}
          </div>
        </div>
      </div>
      {!account.added && (
        <div className="pb-3">
          <Banner
            tone="info"
            title={t('product.add_device_clipboard')}
            action={
              <Link
                to="/signin/choices?returnTo=%2Fsettings"
                className="font-semibold"
                data-testid="settings-add-device"
              >
                {t('product.add_device_btn')}
              </Link>
            }
          >
            {t('product.not_added_p')}
          </Banner>
        </div>
      )}
      {account.added && (
        <>
          <div className={row}>
            <History aria-hidden size={18} className="flex-none text-fg-2" />
            <span className="flex-1">
              {t('product.history_sync')}
              <span className="block text-caption text-fg-2">{t('product.history_sync_p')}</span>
            </span>
            <Switch
              checked={syncOn}
              onChange={(v) => void toggleSync(v)}
              label={t('product.history_sync')}
              disabled={!account.me || syncBusy}
            />
          </div>
          <KeyRow />
        </>
      )}
      <Link to="/devices" className={`${row} text-fg no-underline hover:text-fg`}>
        <MonitorSmartphone aria-hidden size={18} className="flex-none text-fg-2" />
        <span className="flex-1">{t('product.manage_devices')}</span>
        <ChevronRight aria-hidden size={18} className="text-fg-3" />
      </Link>
      <div className={row}>
        <Cloud aria-hidden size={18} className="flex-none text-fg-3" />
        <span className="flex-1 text-fg-2">
          {t('common.s_cloud')}
          <span className="block text-caption">{t('product.cloud_later')}</span>
        </span>
        <Switch checked={false} onChange={() => undefined} label={t('common.s_cloud')} disabled />
      </div>
      {pw ? (
        <ChangePassword onClose={() => setPw(false)} />
      ) : (
        <button type="button" onClick={() => setPw(true)} className={`${row} bg-transparent text-left text-fg`}>
          <KeyRound aria-hidden size={18} className="flex-none text-fg-2" />
          <span className="flex-1">{t('web_vv.k44')}</span>
          <ChevronRight aria-hidden size={18} className="text-fg-3" />
        </button>
      )}
      <button
        type="button"
        onClick={() => setSigningOut(true)}
        className={`${row} bg-transparent text-left font-semibold text-danger-ink`}
      >
        <LogOut aria-hidden size={18} className="flex-none" />
        {t('web_vv.k47')}
      </button>
      <ConfirmDialog
        open={signingOut}
        title={t('product.signout_h')}
        body={
          <div className="flex flex-col gap-3">
            <p className="m-0">{t('product.signout_p')}</p>
            <span className="text-caption font-semibold text-fg">{t('product.signout_history')}</span>
            <Segmented
              label={t('product.signout_history')}
              value={keep}
              onChange={setKeep}
              options={[
                { value: 'keep', label: t('product.signout_keep') },
                { value: 'clear', label: t('product.signout_clear') },
              ]}
            />
          </div>
        }
        confirmLabel={t('web_vv.k47')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy}
        onCancel={() => setSigningOut(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await account.signOut(keep === 'clear');
            toast.show(t('product.signed_out'));
          } catch {
            toast.show(t('product.signout_failed'));
          } finally {
            setBusy(false);
            setSigningOut(false);
          }
        }}
      />
    </div>
  );
}
