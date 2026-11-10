import { CircleCheck, Download, FolderOpen, HardDrive, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button, Card, Screen } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { formatBytes } from '../../lib/format';
import { useReceiver } from '../../features/transfer/TransferContext';
import { useSocketEvents } from '../../features/sharing/SharingContext';
import { SecurityWords } from '../../features/sharing/ParticipantCard';
import { detectCapabilities, planSave, type Capabilities, type Plan } from '../../features/transfer/storage/capability';
import { folderPermission, folderPickerAvailable, pickFolder } from '../../features/transfer/storage/folder';
import { probeOpfs } from '../../features/transfer/storage/opfs';
import type { SaveMode } from '../../features/transfer/storage/progress-store';

const ICON = { folder: FolderOpen, opfs: HardDrive, memory: Download } as const;

/**
 * RX-5b Save location (`receive-save`): the browser capability check (PRD §6.8) and the save target. The
 * transfer starts as soon as the receiver chooses (PRD §5.4). Also shown after a reload when the browser
 * needs permission for the remembered folder again.
 */
export default function SaveLocationPage() {
  const { sessionId = '' } = useParams();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [rx, state, loadFailed] = useReceiver(sessionId);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [mode, setMode] = useState<SaveMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Removed, blocked, or the session ended while choosing: the receive page shows the outcome.
  useSocketEvents((e) => {
    if (
      e.session_id === sessionId &&
      ['PARTICIPANT_REMOVED', 'PARTICIPANT_BLOCKED', 'SESSION_CLOSED', 'SESSION_EXPIRED'].includes(e.type)
    )
      navigate(`/receive/${sessionId}`, { replace: true });
  });

  useEffect(() => {
    let live = true;
    void detectCapabilities(probeOpfs, () => folderPickerAvailable()).then((c) => live && setCaps(c));
    return () => {
      live = false;
    };
  }, []);

  const plan: Plan | null = caps ? planSave(caps, state.total) : null;
  useEffect(() => {
    if (plan && mode === null) setMode(plan.recommended);
  }, [plan, mode]);

  if (!['loading', 'choose', 'permission'].includes(state.phase))
    return <Navigate to={`/receive/${sessionId}`} replace />;

  const senderName = rx.senderDisplayName;
  const count =
    state.files.length === 1 ? t('product.files_count_one') : t('product.files_count', { n: state.files.length });

  const start = async () => {
    if (!mode) return;
    setBusy(true);
    setNotice(null);
    try {
      if (mode === 'folder') {
        setNotice(t('product.save_picking'));
        const folder = await pickFolder();
        if (!folder) {
          setNotice(t('product.save_pick_cancelled'));
          setBusy(false);
          return;
        }
        await rx.start({ sessionId, mode, folder, folderName: folder.name });
      } else {
        await rx.start({ sessionId, mode });
      }
      navigate(`/receive/${sessionId}`, { replace: true });
    } catch {
      setNotice(t('product.error_generic'));
      setBusy(false);
    }
  };

  const regrant = async () => {
    const target = state.target;
    if (!target?.folder) return;
    setBusy(true);
    if (await folderPermission(target.folder, true)) {
      await rx.start(target);
      navigate(`/receive/${sessionId}`, { replace: true });
    } else {
      setBusy(false);
      setNotice(t('product.save_pick_cancelled'));
    }
  };

  if (state.phase === 'permission' && state.target) {
    return (
      <Screen id="receive-save">
        <div className="mx-auto flex w-full max-w-[600px] flex-col gap-4">
          <h1 className="m-0 text-[clamp(24px,3vw,30px)] tracking-[-0.025em]">
            {t('product.folder_permission_h', { folder: state.target.folderName ?? '' })}
          </h1>
          <p className="m-0 text-fg-2">{t('product.folder_permission_p')}</p>
          {notice && <Banner tone="warning" role="alert" title={notice} />}
          <Button variant="receive" size="lg" busy={busy} onClick={() => void regrant()}>
            {t('product.folder_permission_btn')}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void rx
                .start({ sessionId, mode: 'opfs' })
                .then(() => navigate(`/receive/${sessionId}`, { replace: true }))
            }
          >
            {t('product.save_opfs_h')}
          </Button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen id="receive-save">
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-4">
        <div className="flex items-center gap-3 rounded-[14px] bg-receive-soft px-4 py-[14px]">
          <CircleCheck aria-hidden size={22} className="flex-none text-receive-ink" />
          <div className="min-w-0 flex-1">
            <b data-testid="joined-title">{t('product.joined_session', { name: senderName })}</b>
            <div className="text-[13px] text-fg-2" data-testid="save-summary">
              {t('product.save_summary', { count, size: formatBytes(state.total, locale), name: senderName })}
            </div>
          </div>
        </div>
        <SecurityWords words={state.words} label={t('web_xx.secw_r')} />
        <h1 className="m-0 text-[clamp(24px,3vw,30px)] tracking-[-0.025em]">{t('web.save_h')}</h1>
        {loadFailed && <Banner tone="danger" role="alert" title={t('product.error_generic')} />}
        {!plan ? (
          <div aria-hidden className="h-[180px] animate-pulse rounded-[16px] bg-surface-2" />
        ) : (
          <>
            <div role="radiogroup" aria-label={t('web.save_h')} className="flex flex-col gap-3">
              {plan.options.map((o) => {
                const Icon = ICON[o.mode];
                const selected = mode === o.mode;
                const reason =
                  o.reason === 'unsupported'
                    ? t('product.save_unsupported')
                    : o.reason === 'storage'
                      ? t('product.save_no_space', {
                          free: formatBytes(caps?.freeBytes ?? 0, locale),
                          need: formatBytes(state.total, locale),
                        })
                      : o.reason === 'too_large'
                        ? t('product.save_too_large')
                        : null;
                return (
                  <button
                    key={o.mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!o.available}
                    data-testid={`save-${o.mode}`}
                    onClick={() => setMode(o.mode)}
                    className={`flex items-start gap-[14px] rounded-[16px] border-2 bg-surface px-[18px] py-4 text-left text-fg disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-send' : 'border-border'}`}
                  >
                    <span
                      aria-hidden
                      className="mt-[2px] flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full border-2 border-send"
                    >
                      <span className={`h-[10px] w-[10px] rounded-full ${selected ? 'bg-send' : 'bg-transparent'}`} />
                    </span>
                    <span className="flex flex-1 flex-col gap-1">
                      <b className="flex flex-wrap items-center gap-2">
                        <Icon aria-hidden size={18} />
                        {t(`product.save_${o.mode}_h`)}
                        {o.mode === plan.recommended && o.available && (
                          <span className="rounded-[6px] bg-receive-soft px-[7px] py-[2px] text-[11px] font-bold text-receive-ink">
                            {t('product.save_recommended')}
                          </span>
                        )}
                      </b>
                      <span className="text-[14px] leading-[1.5] text-fg-2">
                        {reason ?? t(`product.save_${o.mode}_p`)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {plan.warnings.map((w) => (
              <Banner key={w} tone="warning" role="status" title={t(`product.warn_${w}`)} />
            ))}
            {!plan.recommended && <Banner tone="danger" role="alert" title={t('product.save_none')} />}
            {caps && <CapabilityTable caps={caps} />}
          </>
        )}
        {notice && (
          <p role="status" className="m-0 flex items-center gap-2 text-[14px] text-fg-2">
            <TriangleAlert aria-hidden size={16} />
            {notice}
          </p>
        )}
        <Button
          variant="receive"
          size="lg"
          busy={busy}
          disabled={!mode || !plan?.options.find((o) => o.mode === mode)?.available || state.phase === 'loading'}
          onClick={() => void start()}
        >
          {t('web.startrx')}
        </Button>
      </div>
    </Screen>
  );
}

/** The detected row of the browser capability matrix (PRD §6.8), shown honestly before the transfer. */
function CapabilityTable({ caps }: { caps: Capabilities }) {
  const { t, locale } = useI18n();
  const rows: Array<[string, string]> = [
    [t('product.cap_browser'), t(`product.family_${caps.family}`)],
    [t('product.cap_folder'), t(caps.folder ? 'product.cap_yes' : 'product.cap_no')],
    [
      t('product.cap_storage'),
      caps.opfs
        ? caps.freeBytes !== null
          ? t('product.cap_free', { size: formatBytes(caps.freeBytes, locale) })
          : t('product.cap_yes')
        : t('product.cap_no'),
    ],
    [
      t('product.cap_background'),
      t(caps.ios ? 'product.cap_keep_open' : caps.mobile ? 'product.cap_slower' : 'product.cap_yes'),
    ],
  ];
  return (
    <Card className="p-4" as="section">
      <h2 className="m-0 mb-2 text-[15px]">{t('product.cap_h')}</h2>
      <dl
        data-testid="capability-row"
        data-family={caps.family}
        data-folder={caps.folder}
        data-opfs={caps.opfs}
        className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[14px]"
      >
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-2">{k}</dt>
            <dd className="m-0 text-right font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
