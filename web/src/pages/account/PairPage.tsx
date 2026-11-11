import { Copy, KeyRound, RefreshCw, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { QRCode } from '../../components/QRCode';
import { Banner, Button } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { formatWait, useCountdown } from '../../lib/identity/identity';
import { CryptoError, checkRecoveryPhrase, normalizePhrase, suggestWords, type PairingReady } from '../../lib/crypto';
import { accountErrorText, useAccount } from '../../features/account/AccountContext';
import { finishPairing, recoverKeys, startPairing, type PairingStart } from '../../features/account/keyFlow';
import { AuthPending, AuthLayout, FormError, Heading, useFlowLink } from './AuthLayout';

type PairState = 'starting' | 'waiting' | 'expired' | 'failed' | 'untrusted' | 'finishing';

/** New device: shows a pairing QR and code, waits for an existing device to send the key. */
function PairWithDevice({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { api } = useAccount();
  const [start, setStart] = useState<PairingStart | null>(null);
  const [state, setState] = useState<PairState>('starting');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const starting = useRef(false);
  const left = useCountdown(start && state === 'waiting' ? start.expiresAt : null);

  const begin = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
    setState('starting');
    setError(null);
    try {
      const s = await startPairing(api);
      if (!mounted.current) return;
      setStart(s);
      setState('waiting');
    } catch (e) {
      if (!mounted.current) return;
      setError(accountErrorText(e, t));
      setState('failed');
    } finally {
      starting.current = false;
    }
  }, [api, t]);

  useEffect(() => {
    mounted.current = true;
    if (!start && !starting.current) void begin();
    return () => {
      mounted.current = false;
    };
  }, [begin, start]);

  // Poll for the wrapped key while the code is valid.
  useEffect(() => {
    if (!start || state !== 'waiting') return;
    let busy = false;
    const id = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const st = await api.pairingStatus(start.pairingId);
        if (st.status === 'expired') setState('expired');
        if (st.status === 'ready') {
          clearInterval(id);
          setState('finishing');
          try {
            await finishPairing(api, start.keys, st as PairingReady);
            onDone();
          } catch (e) {
            setState(e instanceof CryptoError && e.code === 'untrusted_sender' ? 'untrusted' : 'failed');
          }
        }
      } catch {
        // A failed poll (offline for a moment) is retried on the next tick.
      } finally {
        busy = false;
      }
    }, 2000);
    return () => clearInterval(id);
  }, [api, start, state, onDone]);

  useEffect(() => {
    if (state === 'waiting' && start && left === 0 && Date.now() >= start.expiresAt) setState('expired');
  }, [left, state, start]);

  const restart = () => {
    setStart(null);
    void begin();
  };

  if (state === 'expired' || state === 'failed' || state === 'untrusted') {
    const title =
      state === 'expired'
        ? t('product.pair_expired')
        : state === 'untrusted'
          ? t('product.pair_untrusted')
          : (error ?? t('product.pair_failed'));
    return (
      <Banner
        tone={state === 'expired' ? 'warning' : 'danger'}
        role="alert"
        title={title}
        action={
          <Button size="sm" icon={RefreshCw} onClick={restart}>
            {t('product.pair_new_code')}
          </Button>
        }
      />
    );
  }
  if (!start || state === 'starting') {
    return (
      <div role="status" className="flex items-center gap-3 text-[14px] text-fg-2">
        <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        {t('product.creating')}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="m-0 self-stretch text-[14px] leading-[1.5]">{t('product.pair_steps')}</p>
      <QRCode value={start.payload} size={196} label={t('product.pair_qr_aria')} />
      <div className="flex w-full flex-col gap-[6px]">
        <span className="text-caption font-semibold" id="pair-code-label">
          {t('product.pair_code_label')}
        </span>
        <div className="flex gap-2">
          <output
            aria-labelledby="pair-code-label"
            data-testid="pairing-code"
            className="min-w-0 flex-1 break-all rounded-md border border-border bg-bg px-3 py-2 font-mono text-caption"
          >
            {start.payload}
          </output>
          <Button
            icon={Copy}
            aria-label={t('product.pair_copy_code')}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(start.payload)
                .then(() => toast.show(t('common.n_copied')))
                .catch(() => undefined)
            }
          />
        </div>
      </div>
      <div role="status" className="flex items-center gap-2 self-start text-caption text-fg-2">
        <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        {state === 'finishing' ? t('product.pair_done') : t('product.pair_waiting')} ·{' '}
        {t('product.code_expires_in', { time: formatWait(left) })}
      </div>
    </div>
  );
}

/** Recovery phrase entry with word suggestions and validation, then Argon2id (Web Worker) and unwrap. */
function RecoverWithPhrase({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { api } = useAccount();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const words = normalizePhrase(text).split(' ').filter(Boolean);
  const partial = /\s$/.test(text) ? '' : (words[words.length - 1] ?? '');
  const suggestions = partial ? suggestWords(partial, 4).filter((w) => w !== partial) : [];
  const check = checkRecoveryPhrase(text);
  // A finished word that is not on the list is flagged at once; the word being typed only after leaving the field.
  const isWord = (w: string) => suggestWords(w, 1)[0] === w;
  const unknown = words.find((w, i) => !isWord(w) && (touched || i < words.length - 1 || w !== partial));
  const problem = unknown
    ? t('product.phrase_unknown', { word: unknown })
    : !check.ok && check.reason === 'checksum'
      ? t('product.phrase_checksum')
      : null;

  const pick = (w: string) => {
    const base = /\s$/.test(text) ? text : text.replace(/\S+$/, '');
    setText(`${base}${w} `);
    inputRef.current?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      await recoverKeys(api, text, (f) => setProgress(Math.round(f * 100)));
      onDone();
    } catch (err) {
      if (err instanceof CryptoError && err.code === 'decrypt_failed') setError(t('product.phrase_wrong'));
      else if (err instanceof CryptoError && err.code === 'invalid_phrase') setError(t('product.phrase_checksum'));
      else setError(accountErrorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3">
      <Heading title={t('product.phrase_h')} body={t('product.phrase_p')} />
      <label htmlFor="recovery-phrase" className="text-caption font-semibold">
        {t('product.phrase_label')}
      </label>
      <textarea
        id="recovery-phrase"
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setTouched(true)}
        rows={3}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby="phrase-count phrase-problem"
        className="min-h-[96px] w-full rounded-md border border-border-strong bg-surface p-3 font-mono text-[14px] text-fg aria-[invalid=true]:border-danger"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id="phrase-count" className="text-caption text-fg-2" aria-live="polite">
          {t('product.phrase_count', { n: words.length })}
        </span>
        {suggestions.length > 0 && (
          <div role="group" aria-label={t('product.phrase_suggestions')} className="flex flex-wrap gap-1">
            {suggestions.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => pick(w)}
                className="min-h-[36px] rounded-full border border-border-strong bg-surface px-3 font-mono text-caption text-fg hover:bg-surface-2"
              >
                {w}
              </button>
            ))}
          </div>
        )}
      </div>
      <span id="phrase-problem" className="text-caption text-danger-ink">
        {problem}
      </span>
      {error && <FormError>{error}</FormError>}
      <Button type="submit" variant="send" size="lg" busy={busy} disabled={!check.ok} className="w-full">
        {busy ? t('product.phrase_unlocking', { percent: progress }) : t('product.phrase_unlock')}
      </Button>
    </form>
  );
}

/**
 * AC-6 `/account/key/pair` (deviation E17): an added device without the Account Data Key gets it from another
 * device (QR or pasted code, one-time pickup) or from the 12-word recovery phrase.
 */
export default function PairPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const account = useAccount();
  const flow = useFlowLink();
  const [mode, setMode] = useState<'device' | 'phrase'>('device');
  const [done, setDone] = useState(false);

  const finish = useCallback(async () => {
    setDone(true);
    await account.refreshKeys();
    navigate(flow('/account/checklist'), { replace: true });
  }, [account, navigate, flow]);

  if (!account.known) return <AuthPending screen="key-pair" />;
  if (account.phase !== 'signed_in') return <Navigate to={flow('/signin')} replace />;
  if (!account.added) return <Navigate to={flow('/signin/choices')} replace />;
  if (account.keys === 'ready' && !done) return <Navigate to={flow('/account/checklist')} replace />;
  if (account.keys === 'setup') return <Navigate to={flow('/account/key/setup')} replace />;

  return (
    <AuthLayout screen="key-pair" wide>
      <span
        aria-hidden
        className="flex h-[48px] w-[48px] items-center justify-center rounded-lg bg-send-soft text-send-ink"
      >
        {mode === 'device' ? <Smartphone size={22} /> : <KeyRound size={22} />}
      </span>
      {mode === 'device' && <Heading title={t('product.pair_h')} body={t('product.pair_p')} />}
      {account.keys === 'unavailable' ? (
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
      ) : mode === 'device' ? (
        <PairWithDevice onDone={finish} />
      ) : (
        <RecoverWithPhrase onDone={finish} />
      )}
      <Button variant="ghost" onClick={() => setMode(mode === 'device' ? 'phrase' : 'device')} className="self-center">
        {mode === 'device' ? t('product.use_phrase') : t('product.use_pairing')}
      </Button>
    </AuthLayout>
  );
}
