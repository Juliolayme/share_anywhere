import { useSyncExternalStore } from 'react';
import { readPref, writePref } from '../../lib/storage';

// Per-device Clipboard Sync UI preference (docs/UX_SCREEN_MAP.md CB-4, CB-6): automatic capture on this browser.
// A UI preference only (on/off), kept through storage.ts; never clipboard content or keys.
const KEY = 'clipboardAuto';
const listeners = new Set<() => void>();

/** Automatic capture (focus/visibility reads where permitted, in-page copies). Default on, as in the design. */
export function getAutoCapture(): boolean {
  return readPref(KEY) !== '0';
}

export function setAutoCapture(on: boolean): void {
  writePref(KEY, on ? '1' : '0');
  for (const l of listeners) l();
}

export function subscribeAutoCapture(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAutoCapture(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeAutoCapture, getAutoCapture, () => true);
  return [on, setAutoCapture];
}
