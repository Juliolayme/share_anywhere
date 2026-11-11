import { Camera, CameraOff, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { useIdentity } from '../../lib/identity/identity';
import { accountErrorText, useAccount } from './AccountContext';
import { lookupCode, sendKeyTo, type CodeLookup } from './keyFlow';

/** Modal frame with a focus trap over every focusable control (the pairing form has inputs, not just buttons). */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('textarea, input, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [
        ...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input, a[href]'),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-full max-w-[480px] flex-col gap-4 overflow-auto rounded-xl bg-surface p-6 shadow-e2"
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="m-0 flex-1 text-title">
            {title}
          </h2>
          <ButtonClose onClose={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

function ButtonClose({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t('common.close')}
      className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-md text-fg-2 hover:bg-surface-2"
    >
      <X aria-hidden size={18} />
    </button>
  );
}

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/** True where the browser can read QR codes from the camera (Chromium on Android, some desktops). */
export function canScanQr(): boolean {
  return (
    typeof window !== 'undefined' &&
    'BarcodeDetector' in window &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Camera preview that reports the first QR payload it reads, then stops the camera. */
function Scanner({ onResult, onError }: { onResult: (text: string) => void; onError: () => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const handlers = useRef({ onResult, onError });
  handlers.current = { onResult, onError };
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped || !video.current) return stop();
        video.current.srcObject = stream;
        await video.current.play();
        const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
        const detector = new Ctor({ formats: ['qr_code'] });
        timer = setInterval(async () => {
          if (!video.current || stopped) return;
          const codes = await detector.detect(video.current).catch(() => []);
          const hit = codes[0]?.rawValue;
          if (hit) {
            stop();
            handlers.current.onResult(hit);
          }
        }, 300);
      } catch {
        stop();
        handlers.current.onError();
      }
    })();
    return stop;
  }, []);
  return (
    <video
      ref={video}
      muted
      playsInline
      aria-label={t('product.pair_scan_video')}
      className="aspect-square w-full rounded-lg bg-surface-2 object-cover"
    />
  );
}

/**
 * AC-6, existing device (DV-1 "Pair a new device"): paste the new device's pairing text (or scan its QR where
 * `BarcodeDetector` exists), check which device is waiting, then wrap the newest key to its ephemeral key.
 */
export function PairDeviceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const account = useAccount();
  const { device } = useIdentity();
  const [text, setText] = useState('');
  const [found, setFound] = useState<CodeLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scan = canScanQr();

  const find = async (value: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await lookupCode(account.api, value);
      if (!res) setError(t('product.pair_invalid'));
      else setFound(res);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('product.pair_not_found') : accountErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void find(text);
  };

  const send = async () => {
    if (!found || !account.userId || !device) return;
    setBusy(true);
    setError(null);
    try {
      await sendKeyTo(account.api, account.userId, device.id, found);
      toast.show(t('product.pair_sent', { name: found.peer.device_name }));
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('product.pair_not_found') : accountErrorText(e, t));
      setFound(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('product.pair_device')} onClose={onClose}>
      {found ? (
        <div className="flex flex-col gap-3" data-testid="pair-confirm">
          <b className="text-[15px]">{t('product.pair_confirm', { name: found.peer.device_name })}</b>
          <p className="m-0 text-[14px] text-fg-2">{t('product.pair_confirm_p')}</p>
          {error && (
            <p role="alert" className="m-0 text-caption text-danger-ink">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setFound(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="send" busy={busy} onClick={send}>
              {t('product.pair_send')}
            </Button>
          </div>
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-3">
          <p className="m-0 text-[14px] leading-[1.5] text-fg-2">{t('product.pair_device_p')}</p>
          {scanning && (
            <Scanner
              onResult={(v) => {
                setScanning(false);
                setText(v);
                void find(v);
              }}
              onError={() => {
                setScanning(false);
                setError(t('product.pair_camera_denied'));
              }}
            />
          )}
          <label htmlFor="pair-code" className="text-caption font-semibold">
            {t('product.pair_paste_label')}
          </label>
          <textarea
            id="pair-code"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'pair-code-error' : undefined}
            className="w-full rounded-md border border-border-strong bg-surface p-3 font-mono text-caption text-fg"
          />
          {error && (
            <p id="pair-code-error" role="alert" className="m-0 text-caption text-danger-ink">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {scan && (
              <Button icon={scanning ? CameraOff : Camera} onClick={() => setScanning((s) => !s)}>
                {scanning ? t('product.pair_scan_stop') : t('product.pair_scan')}
              </Button>
            )}
            <Button type="submit" variant="send" busy={busy} disabled={!text.trim()}>
              {t('product.pair_find')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
