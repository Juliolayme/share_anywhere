import { applyTheme, getThemePreference, setThemePreference } from './theme';

describe('theme preference', () => {
  it('defaults to system and removes data-theme', () => {
    expect(getThemePreference()).toBe('system');
    document.documentElement.setAttribute('data-theme', 'dark');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('persists and applies light and dark', () => {
    setThemePreference('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(getThemePreference()).toBe('dark');
    setThemePreference('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores unknown stored values', () => {
    window.localStorage.setItem('sa.pref.theme', 'purple');
    expect(getThemePreference()).toBe('system');
  });
});
