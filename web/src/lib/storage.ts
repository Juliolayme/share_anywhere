// Small wrapper for per-device UI preferences (theme, language). Never store tokens or secrets here.
// Every access is wrapped because storage can be unavailable (private mode, blocked site data).
const PREFIX = 'sa.pref.';

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    /* preference is not persisted; the UI still works for this visit */
  }
}
