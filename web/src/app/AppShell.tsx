import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight,
  Clipboard,
  History,
  Languages,
  Moon,
  MonitorSmartphone,
  Settings,
  Sun,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { Logo } from '../components/Logo';
import { useI18n } from '../i18n/i18n';
import { flags } from '../config/flags';
import { useIdentity } from '../lib/identity/identity';
import { useOnline } from '../lib/online';
import { useTheme } from '../lib/theme';
import { useAccount } from '../features/account/AccountContext';
import { withReturnTo } from '../features/account/returnTo';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  match: (path: string) => boolean;
}

const TRANSFER_PATHS = ['/', '/send', '/receive'];

export function useNavItems(): NavItem[] {
  const { t } = useI18n();
  const items: NavItem[] = [
    {
      to: '/',
      label: t('web.nav_home'),
      icon: ArrowLeftRight,
      match: (p) => TRANSFER_PATHS.some((x) => p === x || (x !== '/' && p.startsWith(x))),
    },
    { to: '/clipboard', label: t('web.nav_clipboard'), icon: Clipboard, match: (p) => p.startsWith('/clipboard') },
    { to: '/history', label: t('web.nav_history'), icon: History, match: (p) => p.startsWith('/history') },
    { to: '/devices', label: t('web.nav_devices'), icon: MonitorSmartphone, match: (p) => p.startsWith('/devices') },
    { to: '/settings', label: t('web.nav_settings'), icon: Settings, match: (p) => p.startsWith('/settings') },
  ];
  // The Clipboard tab exists only while Clipboard Sync is built (CLAUDE.md §8b); it needs accounts.
  return items.filter((i) => i.to !== '/clipboard' || (flags.clipboard && flags.accounts));
}

export function HeaderControls() {
  const { t, locale, setLocale } = useI18n();
  const theme = useTheme();
  const dark = theme.resolved === 'dark';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setLocale(locale === 'en' ? 'vi' : 'en')}
        // The accessible name contains the visible code (WCAG 2.5.3, axe label-content-name-mismatch).
        aria-label={`${t('web_vv.k51')}: ${locale === 'en' ? 'EN' : 'VI'}`}
        className="inline-flex h-[44px] min-w-touch items-center gap-[6px] rounded-md px-[10px] text-caption font-semibold text-fg-2 hover:bg-surface-2"
      >
        <Languages aria-hidden size={18} />
        {locale === 'en' ? 'EN' : 'VI'}
      </button>
      <button
        type="button"
        onClick={() => theme.set(dark ? 'light' : 'dark')}
        aria-label={t('common.s_theme')}
        aria-pressed={dark}
        className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-md text-fg-2 hover:bg-surface-2"
      >
        {dark ? <Sun aria-hidden size={18} /> : <Moon aria-hidden size={18} />}
      </button>
    </div>
  );
}

const initialOf = (email: string) => (email.trim()[0] ?? '?').toUpperCase();

/** Header identity chip: Guest + Sign in, or the account's initial and email (links to Settings). */
function IdentityChip() {
  const { t } = useI18n();
  const account = useAccount();
  const { pathname, search } = useLocation();
  if (!account.enabled) return null;
  if (account.phase === 'guest') {
    return (
      <Link
        to={withReturnTo('/signin', `${pathname}${search}`)}
        data-testid="header-signin"
        className="inline-flex h-control-sm items-center rounded-md border border-border-strong bg-surface px-3 text-caption font-semibold text-fg no-underline hover:bg-surface-2 hover:text-fg"
      >
        {t('web.signin')}
      </Link>
    );
  }
  const email = account.me?.email ?? '';
  return (
    <Link
      to="/settings"
      aria-label={t('product.account_chip', { email: email || t('product.badge_signed_in') })}
      data-testid="header-account"
      className="inline-flex h-[44px] max-w-[260px] items-center gap-2 rounded-md px-2 text-caption font-semibold text-fg no-underline hover:bg-surface-2 hover:text-fg"
    >
      <span
        aria-hidden
        className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-send text-on-send"
      >
        {email ? initialOf(email) : <User size={16} />}
      </span>
      <span className="hidden truncate rail:inline">{email}</span>
    </Link>
  );
}

/** Sidebar identity panel (design sidebar): Guest with Sign in, or the signed-in account. */
function SidebarIdentity() {
  const { t } = useI18n();
  const account = useAccount();
  const { pathname, search } = useLocation();
  const signedIn = account.phase === 'signed_in';
  const email = account.me?.email ?? '';
  return (
    <div className="flex flex-col gap-[10px] rounded-lg border border-border bg-bg p-[14px]">
      <div className="flex items-center gap-[10px]">
        <span
          aria-hidden
          className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full ${signedIn ? 'bg-send text-on-send' : 'bg-surface-2 text-fg-2'}`}
        >
          {signedIn && email ? <b className="text-[14px]">{initialOf(email)}</b> : <User size={18} />}
        </span>
        <div className="min-w-0">
          <b className="block truncate text-[14px]">
            {signedIn ? email || t('product.badge_signed_in') : t('web.guest')}
          </b>
          <div className="text-[12px] leading-4 text-fg-2">
            {signedIn
              ? account.added
                ? t('product.badge_signed_in')
                : t('product.ck_not_added')
              : t('product.sidebar_guest_p')}
          </div>
        </div>
      </div>
      {account.enabled && !signedIn && (
        <Link
          to={withReturnTo('/signin', `${pathname}${search}`)}
          className="inline-flex h-[40px] items-center justify-center rounded-md border border-border-strong bg-surface text-caption font-semibold text-fg no-underline hover:bg-surface-2 hover:text-fg"
        >
          {t('web.signin')}
        </Link>
      )}
    </div>
  );
}

function StatusPill() {
  const { t } = useI18n();
  const online = useOnline();
  const { status } = useIdentity();
  const [dot, text] = !online
    ? ['bg-warning', t('common.off_h')]
    : status.kind === 'ready'
      ? ['bg-receive', t('product.online_ready')]
      : status.kind === 'loading'
        ? ['bg-fg-3', t('product.identity_loading')]
        : ['bg-danger', t('product.identity_failed')];
  return (
    <span role="status" className="hidden items-center gap-2 text-caption text-fg-2 rail:inline-flex">
      <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
      {text}
    </span>
  );
}

const navClass = (active: boolean) =>
  active ? 'bg-send-soft text-send-ink font-bold' : 'text-fg-2 font-semibold hover:bg-surface-2';

// The path this document was loaded at, and whether its screen was shown (module state: one per page load).
const loadPath = typeof window === 'undefined' ? '' : window.location.pathname;
let loadScreenShown = false;

export function AppShell() {
  const { t } = useI18n();
  const items = useNavItems();
  const { pathname, state } = useLocation();
  // A navigation inside one screen (History list ↔ entry drawer) passes `{ keepFocus: true }` and manages focus itself.
  const keepFocus = (state as { keepFocus?: boolean } | null)?.keepFocus === true;

  // Focus moves to the main region on navigation, so screen readers start at the new screen, including the first
  // shell screen after Welcome or sign-in; but not on the screen the page loaded with, which would put "Skip to
  // content" behind the focus (it must be the first Tab stop).
  useEffect(() => {
    if (!loadScreenShown && pathname === loadPath) {
      loadScreenShown = true;
      return;
    }
    loadScreenShown = true;
    if (!keepFocus) document.getElementById('main')?.focus({ preventScroll: true });
  }, [pathname, keepFocus]);

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('product.skip_to_content')}
      </a>
      {/* Sidebar from 1100 px */}
      <aside className="sticky top-0 hidden h-screen w-[256px] flex-none flex-col gap-6 border-r border-border bg-surface px-[14px] py-6 sidebar:flex">
        <div className="px-[10px] py-1">
          <Logo size={30} lockup />
        </div>
        <nav aria-label={t('product.nav_main')} className="flex flex-col gap-[2px]">
          {items.map((n) => {
            const active = n.match(pathname);
            return (
              <NavLink
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={`flex h-[44px] items-center gap-3 rounded-md px-3 text-[14px] no-underline ${navClass(active)}`}
              >
                <n.icon aria-hidden size={19} />
                <span className="flex-1">{n.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="flex-1" />
        <SidebarIdentity />
      </aside>
      {/* Icon rail from 760 to 1099 px */}
      <aside className="sticky top-0 hidden h-screen w-[80px] flex-none flex-col items-center gap-[18px] border-r border-border bg-surface px-2 py-[18px] rail:flex sidebar:hidden">
        <Logo size={32} />
        <nav aria-label={t('product.nav_main')} className="flex w-full flex-col gap-[6px]">
          {items.map((n) => {
            const active = n.match(pathname);
            return (
              <NavLink
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[56px] flex-col items-center gap-1 rounded-[12px] px-[2px] py-[10px] text-[11px] no-underline ${navClass(active)}`}
              >
                <n.icon aria-hidden size={20} />
                {n.label}
              </NavLink>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-[60px] flex-none items-center gap-3 border-b border-border bg-bg px-[clamp(16px,3vw,40px)]">
          {/* Below 400 px the header also holds the identity chip, so the logo drops its wordmark. */}
          <span className="hidden min-[400px]:inline rail:hidden">
            <Logo size={28} lockup />
          </span>
          <span className="min-[400px]:hidden">
            <Logo size={28} />
          </span>
          <StatusPill />
          <span className="flex-1" />
          <HeaderControls />
          <span className="sidebar:hidden">
            <IdentityChip />
          </span>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto box-border flex w-full max-w-[1200px] flex-1 flex-col gap-6 px-[clamp(16px,3vw,40px)] pb-[96px] pt-[clamp(16px,3vw,36px)] outline-none rail:pb-12"
        >
          <Outlet />
        </main>
      </div>
      {/* Bottom bar below 760 px */}
      <nav
        aria-label={t('product.nav_main')}
        className="fixed inset-x-0 bottom-0 z-[15] grid h-[72px] border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] rail:hidden"
        style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}
      >
        {items.map((n) => {
          const active = n.match(pathname);
          return (
            <NavLink
              key={n.to}
              to={n.to}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-1 text-[11px] no-underline ${active ? 'font-bold text-send-ink' : 'font-semibold text-fg-2'}`}
            >
              <span
                aria-hidden
                className={`flex h-[30px] w-[52px] items-center justify-center rounded-[15px] ${active ? 'bg-send-soft' : ''}`}
              >
                <n.icon size={19} />
              </span>
              {n.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
