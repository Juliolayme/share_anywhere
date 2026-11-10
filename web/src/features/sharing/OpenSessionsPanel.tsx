import { CircleAlert, CircleCheck, Share2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, ConfirmDialog } from '../../components/ui';
import { useI18n, type Translate } from '../../i18n/i18n';
import { ApiError } from '../../lib/api/errors';
import { formatWhen } from '../../lib/format';
import { serverOffset, type OpenSession, type OpenSessionList } from './api';
import { useSharing } from './SharingContext';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; list: OpenSessionList; offset: number };

/** "trip.mp4", or "trip.mp4 + 2 files" for a session with several files. */
export function sessionTitle(t: Translate, s: Pick<OpenSession, 'first_file_name' | 'file_count'>): string {
  const more = s.file_count - 1;
  if (more <= 0) return s.first_file_name;
  return more === 1
    ? t('product.history_title_more_one', { name: s.first_file_name })
    : t('product.history_title_more', { name: s.first_file_name, n: more });
}

function windowLabel(t: Translate, s: OpenSession, locale: string): string {
  switch (s.join_window.state) {
    case 'OPEN':
      return t('product.open_session_window_open', {
        time: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(Date.parse(s.join_window.ends_at)),
      });
    case 'ENDED_FULL':
      return t('product.open_session_window_full');
    case 'ENDED_BY_SENDER':
      return t('product.not_accepting_s');
    default:
      return t('product.open_session_window_expired');
  }
}

/**
 * The device's open sessions (GET /v1/sessions), shown on the send screen when Create hits the open-session
 * cap (409 too_many_open_sessions, docs/SECURITY_MODEL.md §5). Each session can be opened or closed; once one
 * is closed the sender can press Create again. `onClosed` runs after every successful close.
 */
export function OpenSessionsPanel({ onClosed }: { onClosed?: () => void }) {
  const { t, locale } = useI18n();
  const { api } = useSharing();
  const navigate = useNavigate();
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [confirm, setConfirm] = useState<OpenSession | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listOpen();
      setLoad({ kind: 'ready', list, offset: serverOffset(list.server_time) });
    } catch {
      setLoad({ kind: 'error' });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const close = async (s: OpenSession) => {
    setClosing(true);
    setCloseError(null);
    try {
      await api.close(s.id);
    } catch (e) {
      // A session that already ended (404) is no longer open either: refresh and move on.
      if (!(e instanceof ApiError && e.status === 404)) {
        setClosing(false);
        setConfirm(null);
        setCloseError(s.id);
        return;
      }
    }
    setClosing(false);
    setConfirm(null);
    setClosed(true);
    onClosed?.();
    await refresh();
  };

  return (
    <Card className="flex flex-col gap-3 p-[18px]" as="div">
      <div data-testid="open-sessions" aria-labelledby={headingId} role="region" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="m-0 text-[17px] font-semibold">
            {t('product.open_sessions_h')}
          </h2>
          {load.kind === 'ready' && (
            <p className="m-0 text-caption text-fg-2">{t('product.open_sessions_p', { max: load.list.max_open })}</p>
          )}
        </div>
        <div aria-live="polite" className="contents">
          {closed && (
            <p data-testid="open-sessions-closed" className="m-0 flex items-center gap-2 text-caption text-success">
              <CircleCheck aria-hidden size={16} />
              {t('product.open_session_closed')}
            </p>
          )}
        </div>
        {load.kind === 'loading' && (
          <p role="status" className="m-0 flex items-center gap-2 text-caption text-fg-2">
            <span
              aria-hidden
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            {t('product.open_sessions_loading')}
          </p>
        )}
        {load.kind === 'error' && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-caption text-danger-ink">
            <CircleAlert aria-hidden size={16} />
            <span className="flex-1">{t('product.open_sessions_error')}</span>
            <Button
              size="sm"
              onClick={() => {
                setLoad({ kind: 'loading' });
                void refresh();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {load.kind === 'ready' && load.list.sessions.length === 0 && (
          <p data-testid="open-sessions-empty" className="m-0 text-caption text-fg-2">
            {t('product.open_sessions_empty')}
          </p>
        )}
        {load.kind === 'ready' && load.list.sessions.length > 0 && (
          <ul className="m-0 flex list-none flex-col p-0">
            {load.list.sessions.map((s) => {
              const title = sessionTitle(t, s);
              return (
                <li
                  key={s.id}
                  data-testid="open-session"
                  className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0"
                >
                  <span
                    aria-hidden
                    className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-md bg-send-soft text-send-ink"
                  >
                    <Share2 size={19} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{title}</div>
                    <div className="text-[12px] text-fg-2">
                      {t('product.open_session_started', {
                        time: formatWhen(Date.parse(s.created_at), locale, Date.now() + load.offset),
                      })}
                      {' · '}
                      {t('product.open_session_receivers', { joined: s.capacity.joined, max: s.capacity.max })}
                      {' · '}
                      {windowLabel(t, s, locale)}
                    </div>
                    {closeError === s.id && (
                      <p role="alert" className="m-0 mt-1 text-[12px] text-danger-ink">
                        {t('product.close_failed')}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      aria-label={t('product.open_session_open_named', { name: title })}
                      onClick={() => navigate(`/send/session/${encodeURIComponent(s.id)}`)}
                    >
                      {t('common.open')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      aria-label={t('product.open_session_close_named', { name: title })}
                      onClick={() => setConfirm(s)}
                    >
                      {t('common.close')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={t('product.close_h')}
        body={t('product.close_p')}
        confirmLabel={t('web.close')}
        cancelLabel={t('common.cancel')}
        danger
        busy={closing}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void close(confirm)}
      />
    </Card>
  );
}
