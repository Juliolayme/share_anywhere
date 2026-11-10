import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/i18n';
import { mmss } from './api';

const THRESHOLDS = [60, 30];

/** The threshold the countdown passed between two readings, or null. Robust to skipped (throttled) ticks. */
export function crossedThreshold(prev: number, cur: number, thresholds = THRESHOLDS): number | null {
  const hit = thresholds.filter((t) => prev > t && cur <= t && cur > 0);
  return hit.length ? Math.min(...hit) : null;
}

/** Polite screen-reader announcement when the join window passes 1:00 and 0:30 (the visible timer stays silent). */
export function ExpiryAnnouncer({ left }: { left: number }) {
  const { t } = useI18n();
  const prev = useRef(left);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const hit = crossedThreshold(prev.current, left);
    if (hit !== null) setMessage(t('product.code_expires_in', { time: mmss(hit) }));
    else if (left > Math.max(...THRESHOLDS)) setMessage(''); // a new window started
    prev.current = left;
  }, [left, t]);
  return (
    <span className="sr-only" aria-live="polite" data-testid="expiry-announcer">
      {message}
    </span>
  );
}
