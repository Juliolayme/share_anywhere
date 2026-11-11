import { CircleCheck, Circle } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { useI18n } from '../../i18n/i18n';
import { useAccount } from '../../features/account/AccountContext';
import { AuthPending, AuthLayout, Heading, useFlowLink, useReturnTo } from './AuthLayout';

function Item({ done, label, action }: { done: boolean; label: string; action?: React.ReactNode }) {
  const { t } = useI18n();
  const Icon = done ? CircleCheck : Circle;
  return (
    <li className="flex items-center gap-3 border-b border-border px-1 py-3 last:border-b-0">
      <Icon aria-hidden size={20} className={done ? 'text-receive-ink' : 'text-fg-3'} />
      <span className="flex-1 text-[15px]">
        {label}
        <span className="sr-only"> · {done ? t('product.ck_done') : t('product.ck_todo')}</span>
      </span>
      {action}
    </li>
  );
}

/**
 * AC-8 `/account/checklist` (design `checklist`) after the first sign-in on this device. Clipboard items stay out
 * until Clipboard Sync exists (Phase 5B, `clipboard` flag), so the action returns to where the flow started.
 */
export default function ChecklistPage() {
  const { t } = useI18n();
  const account = useAccount();
  const returnTo = useReturnTo();
  const flow = useFlowLink();
  if (!account.known) return <AuthPending screen="checklist" />;
  if (account.phase !== 'signed_in') return <Navigate to={flow('/signin')} replace />;
  const keyReady = account.keys === 'ready';
  const syncOn = account.me?.history_sync === true;
  return (
    <AuthLayout screen="checklist">
      <Heading title={t('web_vv.k28')} body={t('web_vv.k29')} />
      <ul className="m-0 flex list-none flex-col p-0" data-testid="checklist">
        <Item done label={t('common.ck_1')} />
        <Item done label={t('product.signed_in_as', { email: account.me?.email ?? '…' })} />
        <Item
          done={account.added}
          label={account.added ? t('common.ck_3') : t('product.ck_not_added')}
          action={
            !account.added && (
              <Link to={flow('/signin/choices')} className="text-caption font-semibold">
                {t('product.add_device_btn')}
              </Link>
            )
          }
        />
        {account.added && (
          <Item
            done={keyReady}
            label={keyReady ? t('product.key_ready') : t('product.ck_no_key')}
            action={
              !keyReady &&
              (account.keys === 'pair' ||
                account.keys === 'rejected' ||
                account.keys === 'refused' ||
                account.keys === 'setup') && (
                <Link
                  to={flow(account.keys === 'setup' ? '/account/key/setup' : '/account/key/pair')}
                  className="text-caption font-semibold"
                >
                  {account.keys === 'setup' ? t('product.key_setup_cta') : t('product.pair_h')}
                </Link>
              )
            }
          />
        )}
        {account.added && <Item done={syncOn} label={syncOn ? t('product.ck_sync_on') : t('product.ck_sync_off')} />}
      </ul>
      <Link
        to={returnTo}
        className="inline-flex h-control-lg items-center justify-center rounded-md bg-send px-6 text-[15px] font-semibold text-on-send no-underline hover:bg-send-hover hover:text-on-send"
      >
        {t('web_vv.k27')}
      </Link>
    </AuthLayout>
  );
}
