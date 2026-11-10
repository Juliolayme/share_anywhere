import { ApiError, NetworkError } from '../../lib/api/errors';
import type { Translate } from '../../i18n/i18n';
import { mmss } from './api';

/** User-facing message for a join or lookup failure (docs/API.md §3, UX_SCREEN_MAP RX-2/RX-4/RX-7). */
export function joinErrorMessage(t: Translate, err: unknown): string {
  if (err instanceof NetworkError) return t('product.identity_offline');
  if (!(err instanceof ApiError)) return t('product.error_generic');
  switch (err.code) {
    case 'code_not_found':
      return t('common.nf_rx');
    case 'join_window_expired':
    case 'link_not_found':
    case 'join_ticket_invalid':
      return t('common.cx_rx');
    case 'session_full':
      return t('product.session_full_rx');
    case 'session_not_accepting':
      return t('product.not_accepting_rx');
    case 'blocked':
      return t('product.blocked_rx');
    case 'session_expired':
      return t('product.session_ended_rx');
    case 'own_session':
      return t('product.own_session');
    case 'locked_out':
    case 'rate_limited':
      return t('product.rate_limited', { time: mmss(err.retryAfterS ?? 60) });
    default:
      return t('product.error_generic');
  }
}
