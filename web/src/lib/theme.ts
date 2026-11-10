import { useSyncExternalStore } from 'react';
import { readPref, writePref } from './storage';

export type ThemePreference = 'system' | 'light' | 'dark';

export function getThemePreference(): ThemePreference {
  const v = readPref('theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Applies the preference to <html data-theme>. "system" removes the attribute so the media query decides. */
export function applyTheme(pref: ThemePreference, root: HTMLElement = document.documentElement): void {
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

const listeners = new Set<() => void>();

export function setThemePreference(pref: ThemePreference): void {
  writePref('theme', pref);
  applyTheme(pref);
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener?.('change', cb);
  return () => {
    listeners.delete(cb);
    mq?.removeEventListener?.('change', cb);
  };
}

/** The effective theme after resolving "system" against the OS setting. */
export function resolvedTheme(pref: ThemePreference = getThemePreference()): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** One theme state for every control (header toggle and Settings), kept in sync. */
export function useTheme(): {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  set: (p: ThemePreference) => void;
} {
  const preference = useSyncExternalStore(subscribe, getThemePreference, () => 'system' as const);
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolvedTheme(preference),
    () => 'light' as const,
  );
  return { preference, resolved, set: setThemePreference };
}
