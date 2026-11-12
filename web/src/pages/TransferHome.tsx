import { ArrowDownLeft, ArrowUpRight, Inbox, Laptop } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Banner, Card, Screen } from '../components/ui';
import { useI18n } from '../i18n/i18n';
import { useOnline } from '../lib/online';
import { useIdentity } from '../lib/identity/identity';
import { useHistory } from '../features/history/HistoryContext';
import { IdentityNotice } from '../features/identity/IdentityNotice';
import { HistoryRow, historyPath } from '../features/history/HistoryRow';

/** TR-1 / design screen `home`: Send and Receive, recent local history, this device. */
export default function TransferHome() {
  const { t } = useI18n();
  const online = useOnline();
  const { device } = useIdentity();
  const { entries, loading } = useHistory();
  const recent = entries.slice(0, 5);

  return (
    <Screen id="home">
      <div className="flex flex-col gap-[6px]">
        <h1 className="m-0 text-[clamp(26px,3vw,32px)] font-bold tracking-[-0.025em]">{t('web.home_h')}</h1>
        <p className="m-0 text-fg-2 [text-wrap:pretty]">{t('web.home_p')}</p>
      </div>
      {!online && (
        <Banner tone="offline" title={t('common.off_h')}>
          {t('common.off_p')}
        </Banner>
      )}
      {online && <IdentityNotice />}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
        <Link
          to="/send"
          className="flex min-h-[180px] flex-col gap-[18px] rounded-xl bg-send p-[clamp(20px,3vw,28px)] text-on-send no-underline hover:bg-send-hover hover:text-on-send"
        >
          <span
            aria-hidden
            className="flex h-[52px] w-[52px] items-center justify-center rounded-lg bg-[rgba(255,255,255,.18)]"
          >
            <ArrowUpRight size={26} />
          </span>
          <span className="flex flex-col gap-[6px]">
            <span className="text-[24px] font-bold tracking-[-0.02em]">{t('web.send')}</span>
            <span className="text-[14px]">{t('web.send_sub')}</span>
          </span>
        </Link>
        <Link
          to="/receive"
          className="flex min-h-[180px] flex-col gap-[18px] rounded-xl border border-border bg-surface p-[clamp(20px,3vw,28px)] text-fg no-underline hover:border-receive hover:text-fg"
        >
          <span
            aria-hidden
            className="flex h-[52px] w-[52px] items-center justify-center rounded-lg bg-receive text-on-receive"
          >
            <ArrowDownLeft size={26} />
          </span>
          <span className="flex flex-col gap-[6px]">
            <span className="text-[24px] font-bold tracking-[-0.02em]">{t('web.receive')}</span>
            <span className="text-[14px] text-fg-2">{t('web.receive_sub')}</span>
          </span>
        </Link>
      </div>

      {loading ? (
        <div aria-hidden className="flex flex-col gap-[14px] rounded-[16px] border border-border bg-surface p-[20px]">
          <span className="h-[14px] w-2/5 animate-pulse rounded-[7px] bg-track" />
          <span className="h-[44px] rounded-md bg-surface-2" />
          <span className="h-[44px] rounded-md bg-surface-2" />
        </div>
      ) : recent.length === 0 ? (
        <div className="flex flex-col items-center gap-[10px] rounded-[16px] border border-dashed border-border-strong bg-surface p-[clamp(24px,4vw,40px)] text-center">
          <span
            aria-hidden
            className="flex h-[52px] w-[52px] items-center justify-center rounded-lg bg-surface-2 text-fg-2"
          >
            <Inbox size={24} />
          </span>
          <b className="text-[17px]">{t('common.empty_h')}</b>
          <span className="max-w-[420px] text-[14px] leading-[1.5] text-fg-2">{t('common.empty_p')}</span>
        </div>
      ) : (
        <Card className="px-2 pb-1 pt-2">
          <div className="flex items-center justify-between px-3 py-[10px]">
            <h2 className="m-0 text-[16px]">{t('web.recent')}</h2>
            <Link to="/history" className="text-caption font-semibold">
              {t('web.viewall')}
            </Link>
          </div>
          <ul className="m-0 list-none p-0">
            {recent.map((h) => (
              <HistoryRow key={h.id} entry={h} compact to={historyPath(h.id)} />
            ))}
          </ul>
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-[18px]">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-[16px]">{t('web.nav_devices')}</h2>
          <Link to="/devices" className="text-caption font-semibold">
            {t('web.viewall')}
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-[38px] w-[38px] items-center justify-center rounded-md bg-surface-2 text-fg-2"
          >
            <Laptop size={18} />
          </span>
          <div className="flex-1 text-caption leading-[1.45] text-fg-2">
            <b className="text-[14px] text-fg">{t('product.this_browser_guest')}</b>
            <br />
            <span data-testid="home-device-name">{device?.display_name ?? t('product.identity_loading')}</span>
          </div>
        </div>
      </Card>
    </Screen>
  );
}
