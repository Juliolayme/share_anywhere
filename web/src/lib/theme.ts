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

export function setThemePreference(pref: ThemePreference): void {
  writePref('theme', pref);
  applyTheme(pref);
}
