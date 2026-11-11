import { Clipboard, KeyRound, LockKeyhole, MousePointerClick, RefreshCw, ShieldAlert } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, PageHeader, Screen } from '../components/ui';
import { useI18n } from '../i18n/i18n';
import { useAccount } from '../features/account/AccountContext';
import { AccountRequiredIntro } from '../features/account/AccountRequiredIntro';
import { KeyProblemBanner } from '../features/account/KeyProblem';
import { useClipboard } from '../features/clipboard/ClipboardContext';
import { useIdentity } from '../lib/identity/identity';

// CB-4 / CB-5 and the clipboard runtime they drive load only for a ready account (docs/UX_SCREEN_MAP.md §10).
const ClipboardHome = lazy(() => import('../features/clipboard/ClipboardHome'));

const RETURN = '/clipboard';
const RETURN_Q = `returnTo=${encodeURIComponent(RETURN)}`;
const linkBtn =
  'inline-flex h-control-md items-center justify-center rounded-md px-4 text-[14px] font-semibold no-underline';

function Skeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{label}</span>
      <div aria-hidden className="h-[132px] animate-pulse rounded-xl bg-surface-2" />
      <div aria-hidden className="h-[64px] animate-pulse rounded-lg bg-surface-2" />
      <div aria-hidden className="h-[64px] animate-pulse rounded-lg bg-surface-2" />
    </div>
  );
}

/** "HTTPS required" (state `insecure`): plain HTTP pages get neither the clipboard API nor WebCrypto. */
function HttpsRequired() {
  const { t } = useI18n();
  return (
    <Banner tone="danger" role="alert" title={t('product.cb_https_h')}>
      <span data-testid="cb-https-required">{t('product.cb_https_p')}</span>
    </Banner>
  );
}

/** A signed-in state that is not ready yet: heading, explanation, and the way forward. */
function StateCard({
  icon: Icon,
  title,
  body,
  testId,
  children,
}: {
  icon: typeof Clipboard;
  title: string;
  body: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-[clamp(18px,3vw,24px)]"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-[44px] w-[44px] flex-none items-center justify-center rounded-lg bg-send-soft text-send-ink"
        >
          <Icon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[17px]">{title}</h2>
          <p className="mb-0 mt-1 text-[14px] leading-[1.5] text-fg-2">{body}</p>
        </div>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </section>
  );
}

function RetryButton({ onRetry, label }: { onRetry: () => unknown; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      icon={RefreshCw}
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRetry();
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

/**
 * `/clipboard` and `/clipboard/:eventId` (design screen `clipboard`; CB-1…CB-5). A guest gets the account-required
 * intro and nothing else: this page never touches the clipboard, and the runtime that does is loaded only for a ready
 * account (ClipboardProvider). Signed in, the account state decides: add this device (CB-2), set up or pair the key
 * (CB-3), key problems, then the Clipboard home (CB-4) and item detail (CB-5).
 */
export default function ClipboardPage() {
  const { t } = useI18n();
  const account = useAccount();
  const clipboard = useClipboard();
  const identity = useIdentity();
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;

  const header = (
    <PageHeader
      title={t('web.cb_h')}
      subtitle={
        <span className="inline-flex items-center gap-[6px] text-caption font-semibold text-receive-ink">
          <LockKeyhole aria-hidden size={14} />
          {t('web.e2e')} · {t('product.cb_text_only')}
        </span>
      }
    />
  );

  // The device token is still loading: wait rather than flash the guest intro to a signed-in user.
  if (!account.known && !account.accountHint && identity.status.kind === 'loading' && secure) {
    return (
      <Screen id="clipboard">
        <Skeleton label={t('product.cb_loading')} />
      </Screen>
    );
  }

  if (account.phase === 'guest') {
    // CB-1. While the token is unknown but this browser held account keys, the neutral line shows instead.
    if (!account.known && account.accountHint) {
      return (
        <Screen id="clipboard">
          {header}
          <Banner tone="offline">{t('product.cb_account_unknown')}</Banner>
        </Screen>
      );
    }
    return (
      <Screen id="clipboard">
        <AccountRequiredIntro
          icon={Clipboard}
          title={t('web_vv.k89')}
          body={t('web_vv.k90')}
          prompt={t('product.sign_in_clipboard')}
          returnTo={RETURN}
          notice={secure ? undefined : <HttpsRequired />}
          points={[
            { icon: LockKeyhole, iconClass: 'text-receive-ink', title: t('web_vv.k91'), body: t('web_vv.k92') },
            { icon: MousePointerClick, iconClass: 'text-send-ink', title: t('web_vv.k93'), body: t('web_vv.k94') },
            { icon: KeyRound, iconClass: 'text-fg-2', title: t('web_vv.k95'), body: t('web_vv.k96') },
          ]}
        />
      </Screen>
    );
  }

  if (!secure) {
    return (
      <Screen id="clipboard">
        {header}
        <HttpsRequired />
      </Screen>
    );
  }

  // CB-2: signed in, this device not added to the account.
  if (!account.added) {
    return (
      <Screen id="clipboard">
        {header}
        <StateCard
          icon={Clipboard}
          title={t('product.add_device_clipboard')}
          body={t('product.not_added_p')}
          testId="cb-add-device"
        >
          <Link
            to={`/signin/choices?${RETURN_Q}`}
            className={`${linkBtn} bg-send text-on-send hover:bg-send-hover hover:text-on-send`}
          >
            {t('product.add_device_btn')}
          </Link>
        </StateCard>
      </Screen>
    );
  }

  const k = account.keys;
  let body: ReactNode;
  if (k === 'rejected' || k === 'refused' || k === 'legacy') {
    body = <KeyProblemBanner status={k} returnTo={RETURN} />;
  } else if (k === 'unavailable') {
    body = <Banner tone="danger" role="alert" title={t('product.cb_keys_unavailable')} />;
  } else if (k === 'error') {
    body = (
      <Banner
        tone="danger"
        role="alert"
        action={<RetryButton onRetry={account.refreshKeys} label={t('common.retry')} />}
      >
        <span data-testid="cb-keys-error">{t('product.keys_error')}</span>
      </Banner>
    );
  } else if (k === 'setup') {
    body = (
      <StateCard icon={KeyRound} title={t('product.cb_setup_h')} body={t('product.cb_setup_p')} testId="cb-key-setup">
        <Link
          to={`/account/key/setup?${RETURN_Q}`}
          className={`${linkBtn} bg-send text-on-send hover:bg-send-hover hover:text-on-send`}
        >
          {t('product.key_setup_cta')}
        </Link>
      </StateCard>
    );
  } else if (k === 'pair') {
    // CB-3: the account has a key this browser does not hold → AC-6 (pairing or recovery phrase).
    body = (
      <StateCard icon={ShieldAlert} title={t('product.cb_pair_h')} body={t('product.cb_pair_p')} testId="cb-pair">
        <Link
          to={`/account/key/pair?${RETURN_Q}`}
          className={`${linkBtn} bg-send text-on-send hover:bg-send-hover hover:text-on-send`}
        >
          {t('product.pair_h')}
        </Link>
        <Link
          to={`/account/key/pair?mode=phrase&${RETURN_Q}`}
          className={`${linkBtn} border border-border-strong bg-surface text-fg hover:bg-surface-2 hover:text-fg`}
        >
          {t('product.use_phrase')}
        </Link>
      </StateCard>
    );
  } else if (k !== 'ready' || (!clipboard.runtime && !clipboard.failed)) {
    body = <Skeleton label={t('product.cb_loading')} />;
  } else if (!clipboard.runtime) {
    body = (
      <Banner tone="danger" role="alert" action={<RetryButton onRetry={clipboard.retry} label={t('common.retry')} />}>
        {t('product.cb_runtime_failed')}
      </Banner>
    );
  } else {
    return (
      <Suspense
        fallback={
          <Screen id="clipboard">
            {header}
            <Skeleton label={t('product.cb_loading')} />
          </Screen>
        }
      >
        <ClipboardHome runtime={clipboard.runtime} />
      </Suspense>
    );
  }
  return (
    <Screen id="clipboard">
      {header}
      {body}
    </Screen>
  );
}
