import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { formatWhen } from '../../lib/format';
import { useAccount } from './AccountContext';
import { KeyProblemBanner } from './KeyProblem';

const RETURN = '%2Fhistory';
const link = 'whitespace-nowrap font-semibold';

function StatusLine({ icon: Icon, children, testId }: { icon: typeof Cloud; children: ReactNode; testId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-caption text-fg-2" role="status" data-testid={testId}>
      <Icon aria-hidden size={14} />
      {children}
    </div>
  );
}

/**
 * HI-1 account banner (docs/UX_SCREEN_MAP.md HI-1): Sign in to sync for guests, add this device, the key state
 * (checking, error with Retry, set up, pair, a key change that did not verify, an update the server refused, legacy
 * keys), the account failing to load (Retry refetches it), Turn on history sync, or the sync status with errors
 * stated plainly ("Syncing…" only while a pass runs). Offline at load with an account marker shows a neutral state, never
 * the guest prompt.
 */
export function SyncBanner() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  if (!account.enabled) return null;
  if (!account.known && account.accountHint) {
    return (
      <StatusLine icon={CloudOff} testId="sync-unknown">
        {t('product.history_account_unknown')}
      </StatusLine>
    );
  }
  if (account.phase === 'guest') {
    return (
      <Banner
        tone="info"
        action={
          <Link to={`/signin?returnTo=${RETURN}`} className={link} data-testid="history-signin">
            {t('web.signin')}
          </Link>
        }
      >
        {t('product.history_signin')}
      </Banner>
    );
  }
  if (!account.added) {
    return (
      <Banner
        tone="info"
        action={
          <Link to={`/signin/choices?returnTo=${RETURN}`} className={link}>
            {t('product.add_device_btn')}
          </Link>
        }
      >
        {t('product.not_added_p')}
      </Banner>
    );
  }
  const k = account.keys;
  if (k === 'rejected' || k === 'refused' || k === 'legacy') return <KeyProblemBanner status={k} returnTo="/history" />;
  if (k === 'unavailable') return <Banner tone="danger" title={t('product.keys_unavailable')} />;
  if (k === 'error') {
    return (
      <Banner
        tone="danger"
        role="alert"
        action={
          <Button
            size="sm"
            icon={RefreshCw}
            busy={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                await account.refreshKeys();
              } finally {
                setRetrying(false);
              }
            }}
          >
            {t('common.retry')}
          </Button>
        }
      >
        <span data-testid="sync-keys-error">{t('product.keys_error')}</span>
      </Banner>
    );
  }
  if (!account.me) {
    if (!account.meError) return null;
    return (
      <Banner
        tone="danger"
        role="alert"
        action={
          <Button
            size="sm"
            icon={RefreshCw}
            busy={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                await account.refreshMe();
              } finally {
                setRetrying(false);
              }
            }}
          >
            {t('common.retry')}
          </Button>
        }
      >
        <span data-testid="sync-me-error">{t('product.account_load_failed')}</span>
      </Banner>
    );
  }
  if (!account.me.history_sync) {
    return (
      <Banner
        tone="info"
        action={
          <Button
            size="sm"
            variant="send"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await account.setHistorySync(true);
              } catch {
                toast.show(t('product.history_sync_failed_toggle'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('product.turn_on_history_sync')}
          </Button>
        }
      >
        {t('common.local')}
      </Banner>
    );
  }
  if (k === 'checking' || k === 'none') {
    return (
      <StatusLine icon={Cloud} testId="sync-checking">
        {t('product.keys_checking')}
      </StatusLine>
    );
  }
  if (k === 'setup') {
    return (
      <Banner
        tone="warning"
        action={
          <Link to={`/account/key/setup?returnTo=${RETURN}`} className={link} data-testid="history-key-setup">
            {t('product.key_setup_cta')}
          </Link>
        }
      >
        {t('product.history_keys_setup')}
      </Banner>
    );
  }
  if (k === 'pair') {
    return (
      <Banner
        tone="warning"
        action={
          <Link to={`/account/key/pair?returnTo=${RETURN}`} className={link} data-testid="history-pair">
            {t('product.pair_h')}
          </Link>
        }
      >
        {t('product.history_pair')}
      </Banner>
    );
  }
  const s = account.sync;
  if (s.state === 'error') {
    return (
      <Banner
        tone={s.offline ? 'offline' : 'danger'}
        role="alert"
        action={
          <Button size="sm" icon={RefreshCw} onClick={() => void account.syncNow()}>
            {t('common.retry')}
          </Button>
        }
      >
        {s.offline ? t('product.history_sync_offline') : t('product.history_sync_failed')}
      </Banner>
    );
  }
  // Before the first pass starts (or when this browser has no local history store to sync), nothing is claimed.
  if (s.state === 'idle') return null;
  return (
    <StatusLine icon={Cloud} testId="sync-status">
      {s.state === 'running'
        ? t('product.history_syncing')
        : t('product.history_synced_at', { when: formatWhen(s.at, locale) })}
      {s.state === 'ok' && s.unreadable > 0 && (
        <span className="text-warning-ink">{t('product.history_unreadable', { n: s.unreadable })}</span>
      )}
      {s.state === 'ok' && (
        <Button variant="link" onClick={() => void account.syncNow()}>
          {t('product.history_sync_now')}
        </Button>
      )}
    </StatusLine>
  );
}
