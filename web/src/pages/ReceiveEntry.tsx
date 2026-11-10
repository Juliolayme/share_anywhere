import { ChevronLeft, CircleAlert, ScanLine } from 'lucide-react';
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card } from '../components/ui';
import { useI18n } from '../i18n/i18n';
import { flags } from '../config/flags';

/** Accepts an https link to this app's /j/<token> route with a base64url capability token (≥ 128 bits). */
export function parseShareLink(raw: string, origin: string = window.location.origin): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const m = url.pathname.match(/^\/j\/([A-Za-z0-9_-]{22,128})$/);
  return m ? (m[1] ?? null) : null;
}

/**
 * RX-1 / design screen `receive`: six-digit code with paste, arrow keys and inline validation (when focus
 * leaves an incomplete code), plus a share-link field validated on blur. The Continue and Open link actions,
 * and the QR hint that depends on the /j/<token> route, appear only with the `sharing` flag (Phase 2).
 */
export default function ReceiveEntry() {
  const { t } = useI18n();
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const complete = digits.every((d) => /^\d$/.test(d));

  const setAt = (i: number, value: string) => {
    const clean = value.replace(/\D/g, '');
    if (clean.length > 1) {
      fill(i, clean);
      return;
    }
    setDigits((d) => d.map((x, j) => (j === i ? clean : x)));
    setError(null);
    if (clean && i < 5) refs.current[i + 1]?.focus();
  };
  const fill = (start: number, text: string) => {
    const chars = text
      .replace(/\D/g, '')
      .slice(0, 6 - start)
      .split('');
    setDigits((d) => d.map((x, j) => (j >= start && j - start < chars.length ? (chars[j - start] ?? x) : x)));
    setError(null);
    refs.current[Math.min(5, start + chars.length)]?.focus();
  };
  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
    if (e.key === 'Enter') submit();
  };
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    fill(i, e.clipboardData.getData('text'));
  };
  const submit = () => {
    if (!complete) {
      setError(t('product.code_incomplete'));
      refs.current[digits.findIndex((d) => !d)]?.focus();
    }
  };
  const checkLink = () => {
    if (!link.trim()) {
      setLinkError(null);
      return;
    }
    setLinkError(parseShareLink(link) !== null ? null : t('product.link_invalid'));
  };
  // Validate when focus leaves the code group with some, but not all, digits entered.
  const groupRef = useRef<HTMLDivElement>(null);
  const onCellBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (groupRef.current?.contains(e.relatedTarget as Node | null)) return;
    const filled = digits.filter((d) => d).length;
    if (filled > 0 && filled < 6) setError(t('product.code_incomplete'));
  };

  return (
    <div data-screen="receive" className="mx-auto flex w-full max-w-[560px] flex-col gap-[20px]">
      <Link
        to="/"
        className="flex items-center gap-[6px] self-start text-caption font-semibold text-fg-2 no-underline hover:text-fg"
      >
        <ChevronLeft aria-hidden size={16} />
        {t('web.nav_home')}
      </Link>
      <div>
        <h1 className="m-0 text-[clamp(24px,3vw,30px)] font-bold tracking-[-0.025em]">{t('web.rc_h')}</h1>
        <p className="mb-0 mt-[6px] text-fg-2">{t('web.rc_p')}</p>
      </div>
      <Card className="flex flex-col gap-4 rounded-xl p-[clamp(18px,4vw,28px)]">
        <div
          role="group"
          aria-label={t('web.code')}
          ref={groupRef}
          className="flex justify-center gap-[clamp(4px,1.4vw,8px)]"
        >
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              value={d}
              onChange={(e) => setAt(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              onPaste={(e) => onPaste(i, e)}
              onBlur={onCellBlur}
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              pattern="[0-9]*"
              aria-label={t('product.digit_label', { n: i + 1 })}
              aria-invalid={error && !d ? true : undefined}
              className={`box-border h-[clamp(52px,13vw,64px)] w-[clamp(40px,11vw,54px)] rounded-[12px] border-[1.5px] bg-surface p-0 text-center font-mono text-[clamp(22px,6vw,28px)] font-medium text-fg ${error && !d ? 'border-danger' : d ? 'border-send' : 'border-border-strong'} ${i === 2 ? 'mr-[clamp(6px,2vw,12px)]' : ''}`}
            />
          ))}
        </div>
        {error && (
          <div role="alert" className="flex items-center justify-center gap-2 text-caption text-danger-ink">
            <CircleAlert aria-hidden size={16} />
            {error}
          </div>
        )}
        {flags.sharing && (
          <Button variant="receive" size="lg" onClick={submit}>
            {t('web.cont')}
          </Button>
        )}
      </Card>
      <Card className="flex flex-col gap-[10px] p-[18px]">
        <label className="text-caption font-semibold" htmlFor="sa-link">
          {t('web.paste')}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="sa-link"
            type="url"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkError(null);
            }}
            onBlur={checkLink}
            onKeyDown={(e) => {
              if (e.key === 'Enter') checkLink();
            }}
            aria-invalid={linkError ? true : undefined}
            aria-describedby={linkError ? 'sa-link-error' : undefined}
            className="h-[44px] min-w-[200px] flex-1 rounded-md border border-border-strong bg-surface px-3 text-[14px] text-fg"
          />
          {flags.sharing && (
            <Button variant="secondary" onClick={checkLink} disabled={!link.trim()}>
              {t('product.open_link')}
            </Button>
          )}
        </div>
        {linkError && (
          <span id="sa-link-error" role="alert" className="text-caption text-danger-ink">
            {linkError}
          </span>
        )}
      </Card>
      {flags.sharing && (
        <div className="flex items-center gap-3 px-1 text-caption text-fg-2">
          <ScanLine aria-hidden size={18} />
          {t('product.scan_hint')}
        </div>
      )}
    </div>
  );
}
