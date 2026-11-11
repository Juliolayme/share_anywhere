import type { ReadPermission } from './status';

// The only module that touches the browser clipboard: `navigator.clipboard`, the clipboard-read permission, the
// page `copy` event and the copy fallback (PRD §7.2, docs/CLIPBOARD_PROTOCOL.md §2.9). It is imported only by the
// clipboard runtime, which the app loads for a signed-in account whose device is added and holds the key; guests
// never load it (the guest Clipboard screen makes no clipboard call of any kind). Nothing here runs on import.
//
// What a website can do, and what this module does not pretend to do: it reads the clipboard when the user clicks
// Sync Clipboard (a user gesture), or on focus / visibility when the site's clipboard-read permission is already
// `granted`; it sees copies made inside its own page; it cannot observe copies made in other apps while it is not
// in front, and it never polls.

export type ReadFailure = 'insecure' | 'unsupported' | 'denied' | 'empty' | 'failed';

export class ClipboardReadError extends Error {
  constructor(readonly reason: ReadFailure) {
    super(`clipboard read: ${reason}`);
    this.name = 'ClipboardReadError';
  }
}

const nav = (): Navigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator);

export function isSecure(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

export function hasReadText(): boolean {
  return typeof nav()?.clipboard?.readText === 'function';
}

export function hasWriteText(): boolean {
  return typeof nav()?.clipboard?.writeText === 'function';
}

/**
 * Reads the clipboard-read permission state without asking for it (`permissions.query` never prompts). Firefox and
 * Safari do not expose this permission name and throw: `unsupported`. `onChange` follows later changes (the user
 * allows or blocks the site in its settings); the returned function stops following.
 */
export async function watchReadPermission(
  onChange: (p: ReadPermission) => void,
): Promise<{ state: ReadPermission; stop: () => void }> {
  const permissions = nav()?.permissions;
  if (!isSecure() || !permissions?.query) return { state: 'unsupported', stop: () => undefined };
  try {
    const status = await permissions.query({ name: 'clipboard-read' as PermissionName });
    const read = (): ReadPermission =>
      status.state === 'granted' || status.state === 'denied' || status.state === 'prompt'
        ? status.state
        : 'unsupported';
    const listener = () => onChange(read());
    status.addEventListener?.('change', listener);
    return { state: read(), stop: () => status.removeEventListener?.('change', listener) };
  } catch {
    return { state: 'unsupported', stop: () => undefined };
  }
}

/**
 * `navigator.clipboard.readText()`. Call it from a click handler (manual Sync) or, for automatic capture, only when
 * the permission is `granted`. Rejections are classified: `denied` (NotAllowedError: permission denied or no user
 * activation), `unsupported`, `empty` (no text), `failed`.
 */
export async function readClipboardText(): Promise<string> {
  if (!isSecure()) throw new ClipboardReadError('insecure');
  const clipboard = nav()?.clipboard;
  if (typeof clipboard?.readText !== 'function') throw new ClipboardReadError('unsupported');
  let text: string;
  try {
    text = await clipboard.readText();
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    throw new ClipboardReadError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
  }
  if (!text || !text.trim()) throw new ClipboardReadError('empty');
  return text;
}

let suppressCopy = 0;

/**
 * Writes `text` to the clipboard from a click (Copy). Uses `writeText`; where that is missing or refused, falls back to
 * selecting a hidden field and `document.execCommand('copy')`, which every engine still honours inside a user gesture.
 * Returns false when both fail (the UI then selects the text for a manual copy). Copies made here are not captured
 * again by the in-page copy listener.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = nav()?.clipboard;
  if (isSecure() && typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the selection fallback */
    }
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  suppressCopy++;
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    suppressCopy--;
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}

/** Calls `fn` when the tab gains focus or becomes visible (the only moments an automatic read is attempted). */
export function onFocusOrVisible(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onFocus = () => fn();
  const onVisible = () => {
    if (document.visibilityState === 'visible') fn();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** The text a `copy` event inside this page is copying: data set by the page, the field selection, or the selection. */
export function copiedText(e: ClipboardEvent, doc: Document = document): string {
  if (e.defaultPrevented) return e.clipboardData?.getData('text/plain') ?? '';
  const active = doc.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active instanceof HTMLInputElement && active.type === 'password') return '';
    const { selectionStart: s, selectionEnd: end, value } = active;
    if (s !== null && end !== null && end > s) return value.slice(s, end);
  }
  return doc.getSelection()?.toString() ?? '';
}

/** Copies made inside this page (Ctrl+C on selected text). Copies in other apps are invisible to a website. */
export function onInPageCopy(fn: (text: string) => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const listener = (e: Event) => {
    if (suppressCopy > 0) return;
    const text = copiedText(e as ClipboardEvent);
    if (text.trim()) fn(text);
  };
  document.addEventListener('copy', listener);
  return () => document.removeEventListener('copy', listener);
}
