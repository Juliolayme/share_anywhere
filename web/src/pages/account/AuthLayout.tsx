import { ChevronLeft, Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { HeaderControls } from '../../app/AppShell';
import { Logo } from '../../components/Logo';
import { useI18n } from '../../i18n/i18n';
import { safeReturnTo } from '../../features/account/returnTo';
import { IdentityNotice } from '../../features/identity/IdentityNotice';

/**
 * Frame of the account screens (design `signin`, `signup`, `forgot`, `trust`, `checklist`): logo and header
 * controls, one centered card. Account screens are reached only from account CTAs (docs/UX_SCREEN_MAP.md §9).
 */
export function AuthLayout({
  screen,
  children,
  wide,
  back,
}: {
  screen: string;
  children: ReactNode;
  wide?: boolean;
  back?: { to: string; label: string };
}) {
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [screen]);
  return (
    <div data-screen={screen} className="flex min-h-screen flex-col bg-bg">
      <div className="flex items-center justify-between gap-3 px-[clamp(16px,4vw,40px)] py-4">
        <Link to="/" className="no-underline">
          <Logo size={30} lockup />
        </Link>
        <HeaderControls />
      </div>
      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className="flex flex-1 items-start justify-center px-4 pb-12 pt-2 outline-none rail:items-center"
      >
        <div
          className={`flex w-full flex-col gap-4 rounded-xl border border-border bg-surface p-[clamp(20px,4vw,32px)] ${wide ? 'max-w-[560px]' : 'max-w-[440px]'}`}
        >
          {back && (
            <Link
              to={back.to}
              className="inline-flex min-h-touch items-center gap-[6px] self-start text-caption font-semibold text-fg-2 no-underline hover:text-fg"
            >
              <ChevronLeft aria-hidden size={16} />
              {back.label}
            </Link>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}

/** The validated `returnTo` of the current account screen. */
export function useReturnTo(): string {
  const [params] = useSearchParams();
  return safeReturnTo(params.get('returnTo'));
}

/** Appends the current flow's `returnTo` to another account screen's path. */
export function useFlowLink(): (path: string) => string {
  const back = useReturnTo();
  return (path: string) => (back === '/' ? path : `${path}?returnTo=${encodeURIComponent(back)}`);
}

export function Heading({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div>
      <h1 className="m-0 text-[clamp(24px,3vw,26px)] font-bold leading-tight tracking-[-0.02em]">{title}</h1>
      {body && <p className="mb-0 mt-[6px] leading-[1.5] text-fg-2">{body}</p>}
    </div>
  );
}

export function FormError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div
      id={id}
      role="alert"
      className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-[10px] text-caption leading-[1.5] text-danger-ink"
    >
      {children}
    </div>
  );
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  hint?: ReactNode;
};

const inputCls =
  'h-[46px] w-full min-w-0 rounded-md border bg-surface px-3 text-[15px] text-fg aria-[invalid=true]:border-danger';

export function TextField({ label, value, onChange, error, hint, ...rest }: FieldProps) {
  const id = useId();
  const describedBy = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="text-caption font-semibold">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${inputCls} border-border-strong`}
        {...rest}
      />
      {hint && (
        <span id={`${id}-hint`} className="text-caption text-fg-2">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className="text-caption text-danger-ink">
          {error}
        </span>
      )}
    </div>
  );
}

export function PasswordField(props: FieldProps) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const { label, value, onChange, error, hint, ...rest } = props;
  const id = useId();
  const describedBy = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="text-caption font-semibold">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputCls} border-border-strong pr-[52px]`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? t('product.password_hide') : t('product.password_show')}
          aria-pressed={shown}
          className="absolute right-1 top-[1px] inline-flex h-[44px] w-[44px] items-center justify-center rounded-md text-fg-2 hover:bg-surface-2"
        >
          {shown ? <EyeOff aria-hidden size={18} /> : <Eye aria-hidden size={18} />}
        </button>
      </div>
      {hint && (
        <span id={`${id}-hint`} className="text-caption text-fg-2">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className="text-caption text-danger-ink">
          {error}
        </span>
      )}
    </div>
  );
}

/** While the device token is still loading, account screens show this instead of redirecting. */
export function AuthPending({ screen }: { screen: string }) {
  const { t } = useI18n();
  return (
    <AuthLayout screen={screen}>
      <IdentityNotice />
      <div role="status" className="flex items-center gap-3 text-[14px] text-fg-2">
        <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        {t('product.identity_loading')}
      </div>
    </AuthLayout>
  );
}
