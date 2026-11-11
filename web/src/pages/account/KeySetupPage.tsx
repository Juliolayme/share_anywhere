import { KeyRound, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Banner, Button } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { accountErrorText, useAccount } from '../../features/account/AccountContext';
import type { PreparedSetup } from '../../features/account/keyFlow';
import { KeyProblemBanner } from '../../features/account/KeyProblem';
import { AuthPending, AuthLayout, FormError, Heading, useFlowLink } from './AuthLayout';

/**
 * AC-5 `/account/key/setup` (deviation E17): the first device of an account creates the Account Data Key and
 * shows the 12-word recovery phrase once. Nothing is stored or sent until the user confirms they saved it; then
 * `POST /v1/keys/setup` and the key is kept on this device.
 */
export default function KeySetupPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const account = useAccount();
  const flow = useFlowLink();
  const [prep, setPrep] = useState<PreparedSetup | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const committed = useRef(false);
  const shouldPrepare = account.phase === 'signed_in' && account.added && account.keys === 'setup' && !exists;

  const prepare = useCallback(() => {
    let live = true;
    let made: PreparedSetup | null = null;
    setFailed(false);
    void import('../../features/account/keyFlow')
      .then((f) => f.prepareSetup())
      .then((p) => {
        made = p;
        if (live) setPrep(p);
        else p.discard();
      })
      .catch((e: unknown) => {
        // The reason (a CryptoError code or exception name, never key material) for diagnosis.
        console.warn(
          'key setup failed:',
          (e as { code?: string } | null)?.code ?? (e as Error | null)?.name,
          String(e),
        );
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (made && !committed.current) made.discard();
    };
  }, []);

  useEffect(() => (shouldPrepare ? prepare() : undefined), [shouldPrepare, prepare]);

  if (!account.known) return <AuthPending screen="key-setup" />;
  if (account.phase !== 'signed_in') return <Navigate to={flow('/signin')} replace />;
  if (!account.added) return <Navigate to={flow('/signin/choices')} replace />;
  if (account.keys === 'ready' && !busy) return <Navigate to={flow('/account/checklist')} replace />;
  if ((account.keys === 'pair' || account.keys === 'rejected') && !exists)
    return <Navigate to={flow('/account/key/pair')} replace />;

  const confirm = async () => {
    if (!prep) return;
    setBusy(true);
    setError(null);
    try {
      await account.api.setupKeys(prep.request);
      committed.current = true;
      await prep.commit();
      await account.refreshKeys();
      navigate(flow('/account/checklist'), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'keys_exist') {
        prep.discard();
        setExists(true);
        await account.refreshKeys();
      } else {
        setError(accountErrorText(err, t));
      }
    } finally {
      setBusy(false);
    }
  };

  const words = prep?.phrase.split(' ') ?? [];
  return (
    <AuthLayout screen="key-setup" wide>
      <span
        aria-hidden
        className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-send-soft text-send-ink"
      >
        <KeyRound size={22} />
      </span>
      <Heading title={t('product.key_setup_h')} body={t('product.key_setup_p')} />
      {exists ? (
        <Banner
          tone="info"
          title={t('product.key_exists')}
          action={
            <Link to={flow('/account/key/pair')} className="font-semibold">
              {t('product.pair_h')}
            </Link>
          }
        />
      ) : account.keys === 'legacy' ? (
        <KeyProblemBanner status="legacy" returnTo="/settings" />
      ) : account.keys === 'unavailable' ? (
        <Banner tone="danger" role="alert" title={t('product.keys_unavailable')} />
      ) : account.keys === 'error' ? (
        <Banner
          tone="danger"
          role="alert"
          title={t('product.keys_error')}
          action={
            <Button size="sm" onClick={() => void account.refreshKeys()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : failed ? (
        <Banner
          tone="danger"
          role="alert"
          title={t('product.key_setup_failed')}
          action={
            <Button size="sm" onClick={prepare}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !prep ? (
        <div role="status" className="flex items-center gap-3 text-[14px] text-fg-2">
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {t('product.key_generating')}
        </div>
      ) : (
        <>
          <ol
            aria-label={t('product.key_words_label')}
            data-testid="recovery-phrase"
            className="m-0 grid list-none grid-cols-2 gap-2 p-0 rail:grid-cols-3"
          >
            {words.map((w, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2 font-mono text-[14px]"
              >
                <span aria-hidden className="w-[20px] text-right text-caption text-fg-3">
                  {i + 1}
                </span>
                <span data-testid="recovery-word">{w}</span>
              </li>
            ))}
          </ol>
          <div className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-[10px] text-caption leading-[1.5] text-warning-ink">
            <TriangleAlert aria-hidden size={16} className="mt-[1px] flex-none" />
            {t('product.key_setup_warn')}
          </div>
          <label className="flex min-h-touch items-center gap-3 text-[14px] font-semibold">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="h-[20px] w-[20px] flex-none accent-send"
            />
            {t('product.key_saved_check')}
          </label>
          {error && <FormError>{error}</FormError>}
          <Button variant="send" size="lg" busy={busy} disabled={!saved} onClick={confirm} className="w-full">
            {t('web_vv.k27')}
          </Button>
        </>
      )}
    </AuthLayout>
  );
}
