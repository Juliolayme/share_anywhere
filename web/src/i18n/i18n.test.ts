// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { format, lookup } from './format';
import { makeTranslate } from './i18n';

const load = (l: string) =>
  JSON.parse(readFileSync(new URL(`../../../shared/i18n/${l}.json`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

function keys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object') return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('i18n', () => {
  it('EN and VI catalogs have identical keys', () => {
    const en = keys(load('en'))
      .filter((k) => k !== 'locale')
      .sort();
    const vi = keys(load('vi'))
      .filter((k) => k !== 'locale')
      .sort();
    expect(vi).toEqual(en);
  });

  it('looks up nested keys and fills named and positional placeholders', () => {
    const cat = { web: { st: { completed: 'Completed' }, n: '{n} files' }, p: '{1} joined' };
    expect(lookup(cat, 'web.st.completed')).toBe('Completed');
    expect(lookup(cat, 'web.missing')).toBeUndefined();
    expect(format('{n} files', { n: 3 })).toBe('3 files');
    expect(format('{1} joined', ['Lan'])).toBe('Lan joined');
    expect(format('{x} left', {})).toBe('{x} left');
  });

  it('falls back to English, then to the key', () => {
    const t = makeTranslate({ web: {} });
    expect(t('web.nav_home')).toBe('Transfer');
    expect(t('nope.key')).toBe('nope.key');
    const vi = makeTranslate(load('vi'));
    expect(vi('web.nav_home')).toBe('Truyền tệp');
  });
});
