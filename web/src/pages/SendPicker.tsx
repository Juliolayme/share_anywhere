import {
  ArrowRight,
  ChevronLeft,
  CircleAlert,
  File as FileIcon,
  FileArchive,
  FileText,
  Film,
  Image,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, Card, Screen } from '../components/ui';
import { useI18n } from '../i18n/i18n';
import { flags } from '../config/flags';
import { formatBytes } from '../lib/format';
import { useOnline } from '../lib/online';

/** Session limit (PRD §6.1). */
export const SESSION_LIMIT_BYTES = 20e9;

interface Picked {
  id: string;
  file: File;
}

function iconFor(f: File): LucideIcon {
  if (f.type.startsWith('video/')) return Film;
  if (f.type.startsWith('image/')) return Image;
  if (/zip|tar|rar|7z|compressed/.test(f.type) || /\.(zip|7z|rar|tar|gz)$/i.test(f.name)) return FileArchive;
  if (f.type.startsWith('text/') || /pdf|document/.test(f.type)) return FileText;
  return FileIcon;
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const { t } = useI18n();
  const labels = [t('product.step_choose'), t('product.step_share'), t('web_vv.k52')];
  return (
    <ol aria-label={t('product.steps')} className="m-0 flex list-none flex-wrap gap-2 p-0 text-caption font-semibold">
      {labels.map((l, i) => (
        <li key={l} className="flex items-center gap-2" aria-current={i + 1 === current ? 'step' : undefined}>
          {i > 0 && (
            <span aria-hidden className="text-fg-3">
              —
            </span>
          )}
          <span className={`flex items-center gap-2 ${i + 1 === current ? 'text-send-ink' : 'text-fg-2'}`}>
            <span
              aria-hidden
              className={`flex h-[24px] w-[24px] items-center justify-center rounded-full text-[12px] ${i + 1 === current ? 'bg-send text-on-send' : 'border-[1.5px] border-border-strong'}`}
            >
              {i + 1}
            </span>
            {l}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * TR-2/TR-3 / design screens `send` and `send-review`: real file picker with drag and drop, file list,
 * total, and the 20 GB limit. Creating the session is behind the `sharing` flag until Phase 2.
 */
export default function SendPicker() {
  const { t, locale } = useI18n();
  const online = useOnline();
  const [files, setFiles] = useState<Picked[]>([]);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const total = files.reduce((a, f) => a + f.file.size, 0);
  const over = total > SESSION_LIMIT_BYTES;

  const add = (list: FileList | null) => {
    if (!list) return;
    const next = [...list].map((file) => ({ id: crypto.randomUUID(), file }));
    setFiles((cur) => [...cur, ...next]);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    add(e.dataTransfer.files);
  };

  return (
    <Screen id="send">
      <div className="flex flex-col gap-[6px]">
        <Link
          to="/"
          className="flex items-center gap-[6px] self-start text-caption font-semibold text-fg-2 no-underline hover:text-fg"
        >
          <ChevronLeft aria-hidden size={16} />
          {t('web.nav_home')}
        </Link>
        <h1 className="m-0 text-[clamp(24px,3vw,30px)] font-bold tracking-[-0.025em]">{t('web.choose_h')}</h1>
      </div>
      <Steps current={1} />
      {!online && (
        <Banner tone="offline" title={t('common.off_h')}>
          {t('common.off_p')}
        </Banner>
      )}
      {/* Drag and drop is an extra path; the file input inside the label is the keyboard-accessible control. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`relative flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed px-[20px] py-[clamp(28px,5vw,56px)] text-center focus-within:outline focus-within:outline-2 focus-within:outline-focus ${drag ? 'border-send bg-send-soft' : 'border-border-strong bg-surface'}`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          data-testid="file-input"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
          className="absolute h-px w-px opacity-0"
        />
        <span
          aria-hidden
          className="flex h-[56px] w-[56px] items-center justify-center rounded-[16px] bg-send-soft text-send-ink"
        >
          <Upload size={26} />
        </span>
        <span className="text-[17px] font-semibold">
          {t('web.drop')} <span className="text-send underline underline-offset-[3px]">{t('web.browse')}</span>
        </span>
        <span className="text-caption text-fg-2">{t('web.limit')}</span>
      </label>
      {files.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-[18px] py-[14px]">
            <b className="text-[15px]">
              {files.length === 1 ? t('product.files_count_one') : t('product.files_count', { n: files.length })}
            </b>
            <span className="font-mono text-caption text-fg-2">
              {t('web.total')} {formatBytes(total, locale)}
            </span>
          </div>
          <ul className="m-0 list-none p-0">
            {files.map(({ id, file }) => {
              const Icon = iconFor(file);
              return (
                <li key={id} className="flex items-center gap-3 border-b border-border px-[18px] py-3">
                  <span
                    aria-hidden
                    className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-md bg-send-soft text-send-ink"
                  >
                    <Icon size={19} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{file.name}</div>
                    <div className="font-mono text-[12px] text-fg-2">
                      {file.type || '—'} · {formatBytes(file.size, locale)}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={t('product.remove_file', { name: file.name })}
                    onClick={() => setFiles((cur) => cur.filter((f) => f.id !== id))}
                    className="flex h-[40px] w-[40px] min-w-touch items-center justify-center rounded-md text-fg-2 hover:bg-surface-2"
                  >
                    <X aria-hidden size={18} />
                  </button>
                </li>
              );
            })}
          </ul>
          {over && (
            <div
              role="alert"
              className="flex items-center gap-2 bg-danger-soft px-[18px] py-3 text-caption text-danger-ink"
            >
              <CircleAlert aria-hidden size={16} />
              {t('product.over_limit', { amount: formatBytes(total - SESSION_LIMIT_BYTES, locale) })}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4 bg-bg px-[18px] py-[14px]">
            <Button variant="ghost" onClick={() => inputRef.current?.click()}>
              {t('web.addmore')}
            </Button>
            {flags.sharing ? (
              <Button variant="send" size="lg" disabled={over}>
                {t('web.create')}
                <ArrowRight aria-hidden size={18} />
              </Button>
            ) : null}
          </div>
        </Card>
      )}
    </Screen>
  );
}
