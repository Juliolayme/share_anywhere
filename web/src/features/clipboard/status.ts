// Capture status of the Web Clipboard home (docs/UX_SCREEN_MAP.md §12 `clipboardStatus`, PRD §5.9, §7.2). Pure, so
// the panel, the runtime and the tests agree on one derivation.

/**
 * What the read side of this browser can do right now:
 * - `insecure`: not a secure context (plain HTTP): no clipboard API and no WebCrypto; "HTTPS required";
 * - `paused`: the account paused sync: nothing is read or sent;
 * - `offline`: no network (or the last send failed to reach the server): captures are encrypted and queued;
 * - `denied`: the browser's clipboard-read permission for this site is denied: manual Sync with paste fallback;
 * - `unsupported`: no `readText`, or the browser exposes no clipboard-read permission state (Firefox, Safari): every
 *   read needs a click, so capture is manual only;
 * - `auto`: permission granted and automatic capture on: opportunistic reads on focus and visibility;
 * - `besteffort`: automatic capture is possible once the browser permits it (permission not decided, or the toggle is
 *   off); Sync Clipboard always works.
 */
export type CaptureStatus = 'insecure' | 'paused' | 'offline' | 'denied' | 'unsupported' | 'auto' | 'besteffort';

/** `navigator.permissions.query({ name: 'clipboard-read' })` result, or `unsupported` when it throws or is absent. */
export type ReadPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface CaptureInputs {
  secure: boolean;
  /** `navigator.clipboard.readText` exists. */
  hasRead: boolean;
  permission: ReadPermission;
  /** The per-device automatic capture preference. */
  autoCapture: boolean;
  /** navigator.onLine, and the last request reached the server. */
  online: boolean;
  /** Account setting `paused`. */
  paused: boolean;
}

export function deriveCaptureStatus(i: CaptureInputs): CaptureStatus {
  if (!i.secure) return 'insecure';
  if (i.paused) return 'paused';
  if (!i.online) return 'offline';
  if (i.permission === 'denied') return 'denied';
  if (!i.hasRead || i.permission === 'unsupported') return 'unsupported';
  if (i.permission === 'granted' && i.autoCapture) return 'auto';
  return 'besteffort';
}

/**
 * Automatic (focus/visibility) reads may run only when the site's permission is already granted and the toggle is on,
 * so they never prompt (and they never poll). Offline they still run: the capture is encrypted and queued.
 */
export function mayAutoRead(i: CaptureInputs): boolean {
  return deriveCaptureStatus({ ...i, online: true }) === 'auto';
}
