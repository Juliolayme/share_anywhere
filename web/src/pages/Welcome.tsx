import { ArrowLeftRight, ArrowRight, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { useI18n } from '../i18n/i18n';
import { HeaderControls } from '../app/AppShell';
import { markWelcomeSeen } from '../lib/prefs';

/**
 * ON-1 / design screen `welcome`: one primary action, Start sharing → Transfer home. No sign-in here; the
 * design's sign-in links and Clipboard Sync feature row appear only with the `accounts` flag (Phase 5A).
 */
export default function Welcome() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const start = () => {
    markWelcomeSeen();
    navigate('/', { replace: true });
  };
  return (
    <div data-screen="welcome" className="flex min-h-screen flex-col">
      <div className="flex items-center justify-between gap-3 px-[clamp(16px,4vw,40px)] py-4">
        <Logo size={32} lockup />
        <HeaderControls />
      </div>
      <main className="flex flex-1 items-center justify-center px-[clamp(16px,4vw,40px)] pb-12 pt-2">
        <div className="grid w-full max-w-[1040px] items-center gap-[clamp(24px,5vw,64px)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
          <div className="flex flex-col gap-6">
            <h1 className="m-0 text-[clamp(32px,4.4vw,52px)] font-extrabold leading-[1.08] tracking-[-0.035em] [text-wrap:balance]">
              {t('web_vv.k31')}
            </h1>
            <p className="m-0 max-w-[460px] text-[17px] leading-[1.6] text-fg-2">{t('web_vv.k32')}</p>
            <ul className="m-0 flex list-none flex-col gap-[14px] p-0">
              <Feature
                icon={<ArrowLeftRight size={18} />}
                cls="bg-send-soft text-send-ink"
                title={t('web_vv.k38')}
                text={t('web_vv.k39')}
              />
              <Feature
                icon={<ShieldCheck size={18} />}
                cls="bg-receive-soft text-receive-ink"
                title={t('product.wl_receivers_h')}
                text={t('product.wl_receivers_p')}
              />
            </ul>
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-[clamp(20px,3vw,32px)]">
            <b className="text-[20px]">{t('web_vv.k33')}</b>
            <button
              type="button"
              onClick={start}
              className="flex h-[56px] items-center justify-center gap-[10px] rounded-[12px] bg-send text-[16px] font-bold text-on-send hover:bg-send-hover"
            >
              {t('web_vv.k34')}
              <ArrowRight aria-hidden size={18} />
            </button>
            <p className="mb-1 mt-[2px] text-caption leading-[1.5] text-fg-2">{t('product.no_account')}</p>
          </div>
        </div>
      </main>
    </div>
  );
}

function Feature({ icon, cls, title, text }: { icon: React.ReactNode; cls: string; title: string; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden className={`flex h-[36px] w-[36px] flex-none items-center justify-center rounded-md ${cls}`}>
        {icon}
      </span>
      <div>
        <b>{title}</b>
        <div className="mt-[2px] text-[14px] text-fg-2">{text}</div>
      </div>
    </li>
  );
}
