import { KeyRound, Laptop, Pencil, Plus, RefreshCw, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, Card, ConfirmDialog } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { formatWhen } from '../../lib/format';
import { useIdentity } from '../../lib/identity/identity';
import { accountErrorText, keyErrorStatus, useAccount } from './AccountContext';
import type { AccountDevice } from './api';
import { KeyProblemBanner } from './KeyProblem';
import type { KeyStatus } from './state';
import { rotateKeys } from './keyFlow';
import { PairDeviceDialog } from './PairDeviceDialog';

const MOBILE = /Android|iPhone|iPad|iOS|Mobile/i;

function DeviceRow({
  d,
  editable,
  canRevoke,
  onRename,
  onRevoke,
}: {
  d: AccountDevice;
  editable: boolean;
  canRevoke: boolean;
  onRename: (d: AccountDevice, name: string) => Promise<void>;
  onRevoke: (d: AccountDevice) => void;
}) {
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const Icon = MOBILE.test(d.platform) ? Smartphone : Laptop;
  useEffect(() => {
    if (editing) input.current?.focus();
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
      await onRename(d, clean);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? t('product.name_invalid') : t('product.rename_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className="flex flex-wrap items-center gap-[14px] border-b border-border px-[18px] py-4 last:border-b-0"
      data-testid="account-device"
    >
      <span
        aria-hidden
        className="relative flex h-[44px] w-[44px] flex-none items-center justify-center rounded-[12px] bg-surface-2"
      >
        <Icon size={21} />
      </span>
      <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
        {editing ? (
          <form onSubmit={save} className="flex flex-wrap gap-[6px]" noValidate>
            <input
              ref={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={t('web_vv.k17')}
              aria-invalid={error ? true : undefined}
              maxLength={60}
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
                setName(d.name);
              }}
            >
              {t('web_vv.k80')}
            </Button>
          </form>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <b className="text-[15px]" data-testid="account-device-name">
              {d.name}
            </b>
            {d.current && (
              <span className="rounded-sm bg-send-soft px-[7px] py-[2px] text-[11px] font-bold text-send-ink">
                {t('web_vv.k81')}
              </span>
            )}
          </span>
        )}
        {error && (
          <span role="alert" className="text-caption text-danger-ink">
            {error}
          </span>
        )}
        <span className="text-caption text-fg-2">
          {d.platform} · {t('product.device_last_seen', { when: formatWhen(Date.parse(d.last_seen_at), locale) })}
        </span>
      </div>
      <span
        className={`inline-flex h-[24px] items-center gap-[5px] rounded-[7px] px-2 text-[12px] font-semibold ${d.added ? 'bg-receive-soft text-receive-ink' : 'bg-surface-2 text-fg-2'}`}
      >
        {d.added ? <ShieldCheck aria-hidden size={14} /> : <ShieldOff aria-hidden size={14} />}
        {d.added ? t('web.st.trusted') : t('web.st.untrusted')}
      </span>
      {d.added && !d.has_key && (
        <span className="inline-flex h-[24px] items-center gap-[5px] rounded-[7px] bg-warning-soft px-2 text-[12px] font-semibold text-warning-ink">
          <KeyRound aria-hidden size={14} />
          {t('product.device_no_key')}
        </span>
      )}
      {editable && !editing && (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={Pencil}
            aria-label={t('product.rename_named', { name: d.name })}
            onClick={() => {
              setName(d.name);
              setEditing(true);
            }}
          >
            {t('web_vv.k76')}
          </Button>
          {!d.current && (
            <Button
              variant="danger-ghost"
              size="sm"
              disabled={!canRevoke}
              aria-label={t('product.revoke_named', { name: d.name })}
              onClick={() => onRevoke(d)}
            >
              {t('web_vv.k77')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * DV-1 / DV-2 signed in (design `devices` signed in): the account's devices with the current one marked. An added
 * device can rename, revoke (then rotates the Account Data Key), and pair a new device; a not-added device sees a
 * read-only list and `product.add_device`.
 */
export default function AccountDevices() {
  const { t } = useI18n();
  const toast = useToast();
  const account = useAccount();
  const { client, device } = useIdentity();
  const [list, setList] = useState<AccountDevice[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [revoking, setRevoking] = useState<AccountDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotateFailed, setRotateFailed] = useState(false);
  /** A rotation the server refused as unauthorized (403) or legacy (409): shown as the key problem, not a retry. */
  const [rotateProblem, setRotateProblem] = useState<KeyStatus | null>(null);
  const [pairing, setPairing] = useState(false);
  const { api, added, userId } = account;
  const keysOk = account.keys === 'ready' || (account.keys === 'setup' && account.keyVersion === 0);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setList((await api.devices()).devices);
    } catch {
      setLoadError(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, added]);

  const rename = async (d: AccountDevice, name: string) => {
    if (d.current) await client.rename(name);
    else await api.renameDevice(d.id, name);
    toast.show(t('common.n_renamed'));
    await load();
  };

  const rotate = async (): Promise<'rotated' | 'none' | 'failed'> => {
    if (!userId || !device) return 'failed';
    try {
      const r = await rotateKeys(api, userId, device.id);
      setRotateFailed(false);
      setRotateProblem(null);
      await account.refreshKeys();
      return r;
    } catch (e) {
      const status = keyErrorStatus(e);
      if (status === 'rejected' || status === 'legacy') setRotateProblem(status);
      else setRotateFailed(true);
      return 'failed';
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.revokeDevice(revoking.id);
      const r = await rotate();
      if (r !== 'failed') {
        toast.show(t(r === 'rotated' ? 'product.revoke_done' : 'product.revoke_done_nokeys', { name: revoking.name }));
      }
      await load();
    } catch (e) {
      toast.show(e instanceof ApiError ? t('product.revoke_failed') : accountErrorText(e, t));
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  };

  return (
    <>
      {!added && (
        <Banner
          tone="info"
          title={t('product.add_device')}
          action={
            <Link to="/signin/choices?returnTo=%2Fdevices" className="font-semibold" data-testid="devices-add-device">
              {t('product.add_device_btn')}
            </Link>
          }
        >
          {t('product.not_added_p')}
        </Banner>
      )}
      {(account.keys === 'rejected' || account.keys === 'legacy' || rotateProblem) && (
        <KeyProblemBanner
          status={account.keys === 'rejected' || account.keys === 'legacy' ? account.keys : (rotateProblem ?? 'none')}
          returnTo="/devices"
        />
      )}
      {rotateFailed && (
        <Banner
          tone="danger"
          role="alert"
          title={t('product.rotate_failed')}
          action={
            <Button size="sm" icon={RefreshCw} onClick={() => void rotate()}>
              {t('product.rotate_retry')}
            </Button>
          }
        />
      )}
      {added && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="send" icon={Plus} disabled={account.keys !== 'ready'} onClick={() => setPairing(true)}>
            {t('product.pair_device')}
          </Button>
          {account.keys !== 'ready' && (
            <span className="text-caption text-fg-2">
              {t('product.pair_need_key')}{' '}
              {(account.keys === 'pair' || account.keys === 'setup') && (
                <Link
                  to={`${account.keys === 'pair' ? '/account/key/pair' : '/account/key/setup'}?returnTo=%2Fdevices`}
                  className="font-semibold"
                >
                  {account.keys === 'pair' ? t('product.pair_h') : t('product.key_setup_cta')}
                </Link>
              )}
            </span>
          )}
        </div>
      )}
      {loadError ? (
        <Banner
          tone="danger"
          role="alert"
          title={t('product.devices_error')}
          action={
            <Button size="sm" icon={RefreshCw} onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : list === null ? (
        <div
          aria-busy="true"
          aria-label={t('product.devices_loading')}
          className="h-[160px] animate-pulse rounded-[16px] bg-surface-2"
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="m-0 list-none p-0" data-testid="account-devices">
            {list.map((d) => (
              <DeviceRow
                key={d.id}
                d={d}
                editable={added}
                canRevoke={keysOk}
                onRename={rename}
                onRevoke={setRevoking}
              />
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title={t('product.revoke_named_h', { name: revoking?.name ?? '' })}
        body={
          <ul className="m-0 flex list-disc flex-col gap-1 pl-[20px]">
            <li>{t('web_vv.k85')}</li>
            <li>{t('product.revoke_history')}</li>
            <li>{t('web_vv.k84')}</li>
            <li>{t('web_vv.k86')}</li>
            <li>{t('product.revoke_files')}</li>
          </ul>
        }
        confirmLabel={t('web_vv.k88')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={revoke}
      />
      {pairing && <PairDeviceDialog onClose={() => setPairing(false)} />}
    </>
  );
}
