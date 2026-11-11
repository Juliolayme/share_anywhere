import { Laptop, MonitorSmartphone, Pencil, RotateCcw, Smartphone } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ConfirmDialog, PageHeader, Screen } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n/i18n';
import { formatWait, useIdentity } from '../lib/identity/identity';
import { ApiError } from '../lib/api/errors';
import { formatDate } from '../lib/format';
import { IdentityNotice } from '../features/identity/IdentityNotice';
import { useAccount } from '../features/account/AccountContext';

// The account device list (rename, revoke, pairing) loads only for signed-in users.
const AccountDevices = lazy(() => import('../features/account/AccountDevices'));

/** DV-1 guest intro (design `devices` guest): the account-wide list needs an account; sharing never does. */
function GuestIntro() {
  const { t } = useI18n();
  const cls =
    'inline-flex h-control-md items-center justify-center rounded-md px-4 text-[14px] font-semibold no-underline';
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-[16px] border border-dashed border-border-strong bg-surface p-[clamp(18px,3vw,24px)]">
      <span
        aria-hidden
        className="flex h-[48px] w-[48px] flex-none items-center justify-center rounded-lg bg-send-soft text-send-ink"
      >
        <MonitorSmartphone size={22} />
      </span>
      <div className="min-w-[220px] flex-1">
        <h2 className="m-0 text-[16px]">{t('web_vv.k82')}</h2>
        <div className="mt-[2px] text-[14px] leading-[1.5] text-fg-2">{t('common.dv_sync_p')}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/signin?returnTo=%2Fdevices"
          className={`${cls} bg-send text-on-send hover:bg-send-hover hover:text-on-send`}
        >
          {t('web.signin')}
        </Link>
        <Link
          to="/signup?returnTo=%2Fdevices"
          className={`${cls} border border-border-strong bg-surface text-fg hover:bg-surface-2 hover:text-fg`}
        >
          {t('web.create_acc')}
        </Link>
      </div>
    </section>
  );
}

const isMobileUA = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

/**
 * DV-1 / design screen `devices`. A guest sees only "This device" (rename, reset identity) and the account intro;
 * a signed-in user sees the account's device list (AccountDevices).
 */
export default function DevicesPage() {
  const { t, locale } = useI18n();
  const account = useAccount();
  const toast = useToast();
  const { client, device, status } = useIdentity();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const Icon = isMobileUA() ? Smartphone : Laptop;
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (clean.length < 1 || [...clean].length > 40) {
      setError(t('product.name_invalid'));
      return;
    }
    setSaving(true);
    try {
      await client.rename(clean);
      setEditing(false);
      setError(null);
      toast.show(t('common.n_renamed'));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? t('product.name_invalid') : t('product.rename_failed'));
    } finally {
      setSaving(false);
    }
  };

  if (account.phase === 'signed_in') {
    return (
      <Screen id="devices">
        <PageHeader title={t('web.dv_h')} subtitle={<p className="m-0">{t('web_vv.k83')}</p>} />
        <IdentityNotice />
        <Suspense fallback={<div aria-hidden className="h-[160px] animate-pulse rounded-[16px] bg-surface-2" />}>
          <AccountDevices />
        </Suspense>
      </Screen>
    );
  }

  return (
    <Screen id="devices">
      <PageHeader title={t('web.dv_h')} subtitle={<p className="m-0">{t('product.no_account')}</p>} />
      <IdentityNotice />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-[14px] px-[18px] py-4">
          <span
            aria-hidden
            className="relative flex h-[44px] w-[44px] flex-none items-center justify-center rounded-[12px] bg-surface-2"
          >
            <Icon size={21} />
            <span
              className={`absolute -bottom-[2px] -right-[2px] h-[12px] w-[12px] rounded-full border-2 border-surface ${status.kind === 'ready' ? 'bg-receive' : 'bg-fg-3'}`}
            />
          </span>
          <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
            {editing ? (
              <form onSubmit={save} className="flex flex-wrap gap-[6px]" noValidate>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label={t('web_vv.k17')}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'rename-error' : undefined}
                  maxLength={60}
                  ref={nameRef}
                  className="h-[38px] min-w-0 flex-1 rounded-sm border border-send bg-surface px-[10px] text-[14px] text-fg"
                />
                <Button type="submit" variant="send" size="sm" busy={saving}>
                  {t('web_vv.k79')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                >
                  {t('web_vv.k80')}
                </Button>
              </form>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <b className="text-[15px]" data-testid="device-name">
                  {device?.display_name ?? t('product.identity_loading')}
                </b>
                <span className="rounded-sm bg-send-soft px-[7px] py-[2px] text-[11px] font-bold text-send-ink">
                  {t('web_vv.k81')}
                </span>
              </span>
            )}
            {error && (
              <span id="rename-error" role="alert" className="text-caption text-danger-ink">
                {error}
              </span>
            )}
            {device && (
              <span className="text-caption text-fg-2">
                {device.platform} · {t('phrases.online_now')} ·{' '}
                {t('product.anon_since', { date: formatDate(device.created_at, locale) })}
              </span>
            )}
          </div>
          {!editing && (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                icon={Pencil}
                disabled={!device}
                onClick={() => {
                  setName(device?.display_name ?? '');
                  setEditing(true);
                }}
              >
                {t('web_vv.k76')}
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                icon={RotateCcw}
                disabled={!device}
                onClick={() => setConfirmReset(true)}
              >
                {t('product.reset_identity')}
              </Button>
            </div>
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={confirmReset}
        title={t('product.reset_identity')}
        body={t('product.reset_identity_p')}
        confirmLabel={t('product.reset_identity')}
        cancelLabel={t('common.cancel')}
        danger
        busy={resetting}
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => {
          setResetting(true);
          try {
            await client.reset();
            toast.show(t('product.reset_done'));
          } catch (err) {
            const wait = err instanceof ApiError && err.status === 429 ? err.retryAfterS : undefined;
            toast.show(wait ? t('product.rate_limited', { time: formatWait(wait) }) : t('product.identity_failed'));
          } finally {
            setResetting(false);
            setConfirmReset(false);
          }
        }}
      />
      {account.enabled && <GuestIntro />}
    </Screen>
  );
}
