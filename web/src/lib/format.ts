/** Decimal byte sizes as the design shows them ("11.54 GB"). */
export function formatBytes(bytes: number, locale = 'en'): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v)} ${units[i]}`;
}

/** Relative time ("3 minutes ago") within a week, then a short date. */
export function formatWhen(epochMs: number, locale = 'en', now = Date.now()): string {
  const diff = Math.round((epochMs - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(diff, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(epochMs);
}

export function formatDate(iso: string, locale = 'en'): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(t) : '';
}

/** Absolute date and time for detail views ("10 Nov 2026, 09:12"). */
export function formatDateTime(epochMs: number, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(epochMs);
}

/** A duration as the design writes it ("6 min 12 sec", "2 sec", "1 hr 5 min"), with locale unit names. */
export function formatDuration(ms: number, locale = 'en'): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const unit = (value: number, u: 'hour' | 'minute' | 'second') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour');
  if (m > 0) return s > 0 ? `${unit(m, 'minute')} ${unit(s, 'second')}` : unit(m, 'minute');
  return unit(s, 'second');
}
