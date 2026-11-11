import { useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { useIdentity } from '../../lib/identity/identity';
import { accountErrorText, useAccount } from '../../features/account/AccountContext';
import { looksLikeEmail, MAX_PASSWORD, MIN_PASSWORD, passwordStrength } from '../../features/account/state';
import { IdentityNotice } from '../../features/identity/IdentityNotice';
import { AuthLayout, FormError, Heading, PasswordField, TextField, useFlowLink, useReturnTo } from './AuthLayout';

const STRENGTH = ['', 'product.pw_weak', 'product.pw_fair', 'product.pw_good', 'product.pw_strong'] as const;
const BAR = ['', 'bg-danger', 'bg-warning', 'bg-send', 'bg-receive'] as const;

function StrengthMeter({ password }: { password: string }) {
  const { t } = useI18n();
  const score = passwordStrength(password);
  return (
    <div className="flex flex-col gap-[6px]" aria-live="polite">
      <div aria-hidden className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`h-1 flex-1 rounded-sm ${i <= score ? BAR[score] : 'bg-track'}`} />
        ))}
      </div>
      <span className="text-caption text-fg-2" data-testid="password-strength">
        {score === 0 ? t('product.password_hint') : t('product.pw_strength', { level: t(STRENGTH[score]) })}
      </span>
    </div>
  );
}

/**
 * AC-1 `/signin` and AC-2 `/signup` (design `signin`, `signup`). Signing in keeps the device ID, so a running
 * transfer goes on; the after-sign-in choices (AC-4) follow. Both return to `returnTo` at the end of the flow.
 */
export default function SignInPage({ mode }: { mode: 'signin' | 'signup' }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { client, status } = useIdentity();
  const account = useAccount();
  const returnTo = useReturnTo();
  const flow = useFlowLink();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  const signup = mode === 'signup';

  // Opening Sign in while already signed in goes straight back.
  if (account.known && account.phase === 'signed_in' && !submitted.current) return <Navigate to={returnTo} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!looksLikeEmail(email)) next.email = t('product.email_invalid');
    if (!password) next.password = t('product.password_required');
    else if (signup && password.length < MIN_PASSWORD) next.password = t('product.password_short');
    setErrors(next);
    if (next.email || next.password) return;
    setBusy(true);
    submitted.current = true;
    try {
      await account.signIn(mode, email.trim(), password);
      navigate(flow('/signin/choices'), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_signed_in') {
        await client.refresh().catch(() => undefined);
        toast.show(t('product.acct_already_signed_in'));
        navigate(returnTo, { replace: true });
        return;
      }
      submitted.current = false;
      setErrors({ form: accountErrorText(err, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout screen={mode} back={{ to: returnTo, label: t('web_vv.k0') }}>
      <Heading title={signup ? t('web.create_acc') : t('web.signin')} body={signup ? t('web_vv.k6') : t('web_vv.k1')} />
      <IdentityNotice />
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label={t('common.email')}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={setEmail}
          error={errors.email ?? null}
          maxLength={254}
          required
        />
        <PasswordField
          label={t('web_vv.k2')}
          autoComplete={signup ? 'new-password' : 'current-password'}
          value={password}
          onChange={setPassword}
          error={errors.password ?? null}
          maxLength={MAX_PASSWORD}
          required
        />
        {signup && <StrengthMeter password={password} />}
        {errors.form && <FormError>{errors.form}</FormError>}
        {!signup && (
          <Link to={flow('/reset')} className="self-start text-caption font-semibold">
            {t('web_vv.k3')}
          </Link>
        )}
        <Button
          type="submit"
          variant="send"
          size="lg"
          busy={busy}
          disabled={status.kind !== 'ready'}
          className="w-full"
        >
          {signup ? t('web.create_acc') : t('web.signin')}
        </Button>
      </form>
      <div className="text-center text-[14px] text-fg-2">
        {signup ? t('web_vv.k5') : t('web_vv.k4')}
        <Link to={flow(signup ? '/signin' : '/signup')} className="font-semibold">
          {signup ? t('web.signin') : t('web.create_acc')}
        </Link>
      </div>
    </AuthLayout>
  );
}
