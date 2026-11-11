import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n/i18n';
import { withReturnTo } from './returnTo';

export interface IntroPoint {
  icon: LucideIcon;
  iconClass: string;
  title: string;
  body: string;
}

/**
 * Account-required intro (PRD §5.9, design `clipboard` guest): what the feature does, why it needs an account, and
 * Sign in / Create account links that come back to `returnTo`. It renders no control of the feature itself, so a guest
 * screen built on it makes no call that needs an account. File sharing never shows this.
 */
export function AccountRequiredIntro({
  icon: Icon,
  title,
  body,
  points,
  prompt,
  returnTo,
  notice,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  points: IntroPoint[];
  /** One line above the buttons. */
  prompt?: string;
  returnTo: string;
  /** Shown under the heading (a browser problem the user should know before signing in). */
  notice?: ReactNode;
}) {
  const { t } = useI18n();
  const btn = 'inline-flex h-[50px] items-center justify-center rounded-lg px-6 text-[15px] font-semibold no-underline';
  return (
    <section
      aria-labelledby="account-intro-h"
      className="mx-auto flex w-full max-w-[640px] flex-col gap-[20px] pt-[clamp(0px,3vw,32px)]"
    >
      <span
        aria-hidden
        className="flex h-[60px] w-[60px] items-center justify-center rounded-[16px] bg-send-soft text-send-ink"
      >
        <Icon size={28} />
      </span>
      <div>
        <h1 id="account-intro-h" className="m-0 text-[clamp(26px,3vw,32px)] font-bold tracking-[-0.025em]">
          {title}
        </h1>
        <p className="mb-0 mt-2 text-[16px] leading-[1.6] text-fg-2">{body}</p>
      </div>
      {notice}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {points.map((p) => (
          <li key={p.title} className="flex items-start gap-3">
            <p.icon aria-hidden size={18} className={`mt-[3px] flex-none ${p.iconClass}`} />
            <span className="leading-[1.5]">
              <b>{p.title}</b> <span className="text-fg-2">{p.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {prompt && <p className="m-0 text-[14px] font-semibold">{prompt}</p>}
      <div className="flex flex-wrap gap-[10px]">
        <Link
          to={withReturnTo('/signin', returnTo)}
          className={`${btn} bg-send text-on-send hover:bg-send-hover hover:text-on-send`}
        >
          {t('web.signin')}
        </Link>
        <Link
          to={withReturnTo('/signup', returnTo)}
          className={`${btn} border border-border-strong bg-surface text-fg hover:bg-surface-2 hover:text-fg`}
        >
          {t('web.create_acc')}
        </Link>
      </div>
    </section>
  );
}
