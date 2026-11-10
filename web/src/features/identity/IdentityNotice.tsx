import { RefreshCw } from 'lucide-react';
import { Banner, Button } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { formatWait, useCountdown, useIdentity } from '../../lib/identity/identity';

/** Inline identity status for Transfer home (PRD §5.1): never blocks navigation; offers a retry. */
export function IdentityNotice() {
  const { t } = useI18n();
  const { status, retry } = useIdentity();
  const left = useCountdown(status.kind === 'rate_limited' ? status.retryAt : null);
  if (status.kind === 'offline') {
    return (
      <Banner tone="offline" title={t('common.off_h')}>
        {t('product.identity_offline')}
      </Banner>
    );
  }
  if (status.kind === 'rate_limited') {
    return (
      <Banner
        tone="warning"
        role="alert"
        title={t('product.identity_failed')}
        action={
          <Button variant="secondary" size="sm" icon={RefreshCw} disabled={left > 0} onClick={retry}>
            {left > 0 ? t('product.retry_in', { time: formatWait(left) }) : t('common.retry')}
          </Button>
        }
      >
        {t('product.rate_limited', { time: formatWait(left) })}
      </Banner>
    );
  }
  if (status.kind === 'failed') {
    return (
      <Banner
        tone="danger"
        role="alert"
        title={t('product.identity_failed')}
        action={
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={retry}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }
  return null;
}
