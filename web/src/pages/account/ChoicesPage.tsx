import { ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Switch } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useIdentity } from '../../lib/identity/identity';
import { accountErrorText, useAccount } from '../../features/account/AccountContext';
import { nextAccountStep } from '../../features/account/state';
import { AuthPending, AuthLayout, FormError, Heading, TextField, useFlowLink } from './AuthLayout';

const STEP_PATH = { setup: '/account/key/setup', pair: '/account/key/pair', checklist: '/account/checklist' };

function Choice({
  label,
  body,
  checked,
  onChange,
}: {
  label: string;
  body: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-[14px]">
      <div className="flex-1">
        <b className="block text-[14px]">{label}</b>
        <span className="text-caption leading-[1.5] text-fg-2">{body}</span>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/**
 * AC-4 `/signin/choices` (design `trust`, deviation A1): after sign-in or sign-up, add this device to the account
 * (default on) and, only when adding, copy its transfer history once (default off). The device keeps its ID.
 */
export default function ChoicesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { client, device } = useIdentity();
  const account = useAccount();
  const flow = useFlowLink();
  const [name, setName] = useState(device?.display_name ?? '');
  const [add, setAdd] = useState(true);
  const [copy, setCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (device && !name) setName(device.display_name);
  }, [device, name]);

  if (!account.known) return <AuthPending screen="trust" />;
  if (account.phase !== 'signed_in') return <Navigate to={flow('/signin')} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (clean.length < 1 || [...clean].length > 40) {
      setError(t('product.name_invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (device && clean !== device.display_name) await client.rename(clean);
      if (add && !account.added) {
        const keys = await account.addDevice(copy);
        navigate(flow(STEP_PATH[nextAccountStep(true, keys)]), { replace: true });
      } else {
        navigate(flow(STEP_PATH[nextAccountStep(account.added, account.keys)]), { replace: true });
      }
    } catch (err) {
      setError(accountErrorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout screen="trust">
      <span
        aria-hidden
        className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-receive-soft text-receive-ink"
      >
        <ShieldCheck size={22} />
      </span>
      <Heading title={t('web_vv.k15')} body={t('web_vv.k16')} />
      {account.me && (
        <p className="m-0 text-caption text-fg-2" data-testid="signed-in-as">
          {t('product.signed_in_as', { email: account.me.email })}
        </p>
      )}
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <TextField label={t('web_vv.k17')} value={name} onChange={setName} maxLength={60} autoComplete="off" />
        {!account.added && (
          <Choice
            label={t('product.add_device')}
            body={add ? t('product.add_device_p') : t('product.add_device_off_p')}
            checked={add}
            onChange={setAdd}
          />
        )}
        {add && !account.added && (
          <Choice
            label={t('product.copy_history')}
            body={t('product.copy_history_p')}
            checked={copy}
            onChange={setCopy}
          />
        )}
        {error && <FormError>{error}</FormError>}
        <Button type="submit" variant="send" size="lg" busy={busy} className="w-full">
          {t('web_vv.k27')}
        </Button>
      </form>
    </AuthLayout>
  );
}
