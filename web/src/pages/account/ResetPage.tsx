import { MailCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { accountErrorText, useAccount } from '../../features/account/AccountContext';
import { looksLikeEmail, MAX_PASSWORD, MIN_PASSWORD } from '../../features/account/state';
import { AuthLayout, FormError, Heading, PasswordField, TextField, useFlowLink } from './AuthLayout';

/** Request form and sent state (design `forgot`). The answer never says whether the account exists. */
function RequestForm() {
  const { t } = useI18n();
  const { api } = useAccount();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!looksLikeEmail(email)) {
      setError(t('product.email_invalid'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.requestReset(email.trim());
      setSent(true);
    } catch (err) {
      setFormError(accountErrorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span
          aria-hidden
          className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-receive-soft text-receive-ink"
        >
          <MailCheck size={22} />
        </span>
        <Heading title={t('web_vv.k8')} body={t('web_vv.k9')} />
      </div>
    );
  }
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <Heading title={t('web_vv.k10')} body={t('common.fp_p')} />
      <TextField
        label={t('common.email')}
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={setEmail}
        error={error}
        maxLength={254}
        required
      />
      {formError && <FormError>{formError}</FormError>}
      <Button type="submit" variant="send" size="lg" busy={busy} className="w-full">
        {t('web_vv.k11')}
      </Button>
    </form>
  );
}

/** `?token=` from the emailed link: choose a new password (every account session ends). */
function NewPasswordForm({ token }: { token: string }) {
  const { t } = useI18n();
  const { api } = useAccount();
  const flow = useFlowLink();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (password.length < MIN_PASSWORD) next.password = t('product.password_short');
    if (confirm !== password) next.confirm = t('product.password_mismatch');
    setErrors(next);
    if (next.password || next.confirm) return;
    setBusy(true);
    try {
      await api.confirmReset(token, password);
      setDone(true);
    } catch (err) {
      setErrors({ form: accountErrorText(err, t) });
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div role="status" className="flex flex-col gap-4">
        <Heading title={t('common.cp_done')} body={t('product.reset_saved')} />
        <Link
          to={flow('/signin')}
          className="inline-flex h-control-lg items-center justify-center rounded-md bg-send px-6 text-[15px] font-semibold text-on-send no-underline hover:bg-send-hover hover:text-on-send"
        >
          {t('web.signin')}
        </Link>
      </div>
    );
  }
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <Heading title={t('product.reset_new_h')} body={t('product.reset_new_p')} />
      <PasswordField
        label={t('common.cp_new')}
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        error={errors.password ?? null}
        hint={t('product.password_hint')}
        maxLength={MAX_PASSWORD}
        required
      />
      <PasswordField
        label={t('common.cp_conf')}
        autoComplete="new-password"
        value={confirm}
        onChange={setConfirm}
        error={errors.confirm ?? null}
        maxLength={MAX_PASSWORD}
        required
      />
      {errors.form && <FormError>{errors.form}</FormError>}
      <Button type="submit" variant="send" size="lg" busy={busy} className="w-full">
        {t('product.save_password')}
      </Button>
    </form>
  );
}

/** AC-3 `/reset` (design `forgot`): request a link, or with `?token=` set a new password. */
export default function ResetPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const flow = useFlowLink();
  // The reset token is read once and dropped from the address bar (and so from the browser history).
  const [token] = useState(() => params.get('token'));
  useEffect(() => {
    if (params.has('token')) navigate(flow('/reset'), { replace: true });
  }, [params, navigate, flow]);
  return (
    <AuthLayout screen="forgot" back={{ to: flow('/signin'), label: t('web_vv.k7') }}>
      {token ? <NewPasswordForm token={token} /> : <RequestForm />}
    </AuthLayout>
  );
}
