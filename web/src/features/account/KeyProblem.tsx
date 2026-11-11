import { Link } from 'react-router-dom';
import { Banner } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import type { KeyStatus } from './state';

/**
 * Key authenticity problems (docs/CLIPBOARD_PROTOCOL.md §1, deviations E20 and E21) shown on Devices, Settings and
 * History:
 * - `rejected`: an incoming key change (rotation) did not verify, or the server reports an older key than this device
 *   holds; nothing was stored and the held keys stay, so the device gets the key again by pairing or with the phrase;
 * - `refused`: the server refused this device's own update (its rotation or its key registration); same way out;
 * - `legacy`: the account's keys predate key authenticity (pre-release data) and must be set up again.
 */
export function KeyProblemBanner({ status, returnTo }: { status: KeyStatus; returnTo: string }) {
  const { t } = useI18n();
  if (status === 'legacy') {
    return (
      <Banner tone="danger" role="alert">
        <span data-testid="keys-legacy">{t('product.keys_legacy')}</span>
      </Banner>
    );
  }
  if (status !== 'rejected' && status !== 'refused') return null;
  const refused = status === 'refused';
  const back = `returnTo=${encodeURIComponent(returnTo)}`;
  const link = 'whitespace-nowrap font-semibold';
  return (
    <Banner
      tone="danger"
      role="alert"
      title={t(refused ? 'product.keys_refused' : 'product.key_change_unverified')}
      action={
        <span className="flex flex-wrap gap-3">
          <Link to={`/account/key/pair?${back}`} className={link} data-testid="key-problem-pair">
            {t('product.pair_again')}
          </Link>
          <Link to={`/account/key/pair?mode=phrase&${back}`} className={link} data-testid="key-problem-phrase">
            {t('product.use_phrase')}
          </Link>
        </span>
      }
    >
      {refused ? (
        <span data-testid="keys-refused">{t('product.keys_refused_p')}</span>
      ) : (
        <span data-testid="key-change-unverified">{t('product.key_change_unverified_p')}</span>
      )}
    </Banner>
  );
}
