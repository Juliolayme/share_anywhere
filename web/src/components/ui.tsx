import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, Info, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';

// Components from design/claude-design/Design System.dc.html, built on the generated token classes.

type Variant = 'send' | 'receive' | 'secondary' | 'ghost' | 'danger-ghost' | 'link';
const VARIANT: Record<Variant, string> = {
  send: 'bg-send text-on-send hover:bg-send-hover disabled:opacity-50',
  receive: 'bg-receive text-on-receive hover:brightness-95 disabled:opacity-50',
  secondary: 'border border-border-strong bg-surface text-fg hover:bg-surface-2 disabled:opacity-50',
  ghost: 'bg-transparent text-fg-2 hover:bg-surface-2 disabled:opacity-50',
  'danger-ghost': 'bg-transparent text-danger-ink hover:bg-danger-soft disabled:opacity-50',
  link: 'bg-transparent text-send hover:text-send-hover underline-offset-2 hover:underline px-1',
};
const SIZE = {
  sm: 'h-control-sm px-3 text-caption',
  md: 'h-control-md px-4 text-[14px]',
  lg: 'h-control-lg px-6 text-[15px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof SIZE;
  icon?: LucideIcon;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    busy,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex min-w-touch items-center justify-center gap-2 rounded-md font-semibold transition-colors duration-fast disabled:cursor-not-allowed ${VARIANT[variant]} ${variant === 'link' ? 'min-h-touch' : SIZE[size]} ${className}`}
      {...rest}
    >
      {busy ? (
        <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        Icon && <Icon aria-hidden size={18} />
      )}
      {children}
    </button>
  );
});

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[28px] w-[46px] flex-none rounded-full transition-colors duration-fast ${checked ? 'bg-send' : 'bg-border-strong'}`}
    >
      <span
        aria-hidden
        className={`absolute top-1 h-[20px] w-[20px] rounded-full bg-[#fff] transition-[left] duration-fast ${checked ? 'left-[21px]' : 'left-[3px]'}`}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const next = (i + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-md bg-surface-2 p-1">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(i + 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(i - 1);
              }
            }}
            className={`min-h-[34px] rounded-sm px-[14px] text-caption font-semibold ${on ? 'bg-surface text-fg shadow-e1' : 'text-fg-2'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type Tone = 'warning' | 'info' | 'danger' | 'offline';
const TONE: Record<Tone, { cls: string; icon: LucideIcon }> = {
  warning: { cls: 'bg-warning-soft text-warning-ink', icon: TriangleAlert },
  offline: { cls: 'bg-warning-soft text-warning-ink', icon: WifiOff },
  info: { cls: 'bg-send-soft text-send-ink', icon: Info },
  danger: { cls: 'bg-danger-soft text-danger-ink', icon: AlertCircle },
};

export function Banner({
  tone,
  title,
  children,
  action,
  role = 'status',
}: {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
}) {
  const { cls, icon: Icon } = TONE[tone];
  return (
    <div
      role={role}
      className={`flex flex-wrap items-start gap-3 rounded-md px-4 py-[14px] text-[14px] leading-[1.5] ${cls}`}
    >
      <Icon aria-hidden size={18} className="mt-[3px] flex-none" />
      <div className="min-w-0 flex-1">
        {title && <b className="block">{title}</b>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function Card({
  children,
  className = '',
  as: As = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div';
}) {
  return <As className={`rounded-[16px] border border-border bg-surface ${className}`}>{children}</As>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-[6px]">
        <h1 className="m-0 text-[clamp(26px,3vw,32px)] font-bold leading-tight tracking-[-0.025em]">{title}</h1>
        {subtitle && <div className="m-0 text-fg-2">{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled])');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="flex w-full max-w-[460px] flex-col gap-4 rounded-xl bg-surface p-6 shadow-e2"
      >
        <h2 id={titleId} className="m-0 text-title">
          {title}
        </h2>
        <div id={bodyId} className="text-[14px] leading-[1.5] text-fg-2">
          {body}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger-ghost' : 'send'} busy={busy ?? false} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Root of a screen, tagged with its design screen ID (docs/UX_SCREEN_MAP.md §12) so tests and QA can
 * locate it. `display: contents` keeps the parent layout unchanged.
 */
export function Screen({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-screen={id} className="contents">
      {children}
    </div>
  );
}
