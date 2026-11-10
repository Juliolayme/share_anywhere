import { Laptop, Pencil, RotateCcw, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Card, ConfirmDialog, PageHeader, Screen } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n/i18n';
import { formatWait, useIdentity } from '../lib/identity/identity';
import { ApiError } from '../lib/api/errors';
import { formatDate } from '../lib/format';
import { IdentityNotice } from '../features/identity/IdentityNotice';

const isMobileUA = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

/** DV-1 / design screen `devices` for a guest: only "This device", with rename and reset identity. */
export default function DevicesPage() {
  const { t, locale } = useI18n();
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
    </Screen>
  );
}
