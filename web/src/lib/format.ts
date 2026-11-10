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
