/** Account screens (docs/UX_SCREEN_MAP.md §9); never a destination to return to, so flows cannot loop. */
const ACCOUNT_PATHS = ['/signin', '/signup', '/reset', '/account'];

/**
 * The screen an account flow returns to (`?returnTo=`). Only a same-origin relative path is accepted: it must
 * start with a single `/`, carry no scheme, host, backslash or control character (also not percent-encoded), and
 * not be an account screen.
 * Anything else falls back to `fallback` (Transfer home).
 */
export function safeReturnTo(raw: string | null | undefined, fallback = '/'): string {
  if (!raw || raw.length > 512) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, 'https://sa.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'https://sa.invalid') return fallback;
  const path = url.pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return fallback;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith('//')) return fallback;
  if (ACCOUNT_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return fallback;
  return `${path}${url.search}${url.hash}`;
}

/** `path?returnTo=<from>` for links into an account flow (from is validated again on arrival). */
export function withReturnTo(path: string, from: string): string {
  const back = safeReturnTo(from, '');
  return back && back !== '/' ? `${path}?returnTo=${encodeURIComponent(back)}` : path;
}
