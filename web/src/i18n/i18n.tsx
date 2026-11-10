import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as en from './catalog-en';
import { format, lookup, type Catalog, type Params } from './format';
import { readPref, writePref } from '../lib/storage';

export type Locale = 'en' | 'vi';

const enCatalog = en as unknown as Catalog;

export function getLocalePreference(): Locale {
  const saved = readPref('lang');
  if (saved === 'en' || saved === 'vi') return saved;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

export type Translate = (key: string, params?: Params) => string;

/** Translator over a catalog with English fallback; a missing key renders as the key itself. */
export function makeTranslate(catalog: Catalog): Translate {
  return (key, params) => format(lookup(catalog, key) ?? lookup(enCatalog, key) ?? key, params);
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue>({
  locale: 'en',
  setLocale: () => undefined,
  t: makeTranslate(enCatalog),
});

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initial ?? getLocalePreference);
  const [catalog, setCatalog] = useState<Catalog>(enCatalog);

  useEffect(() => {
    let cancelled = false;
    if (locale === 'en') {
      setCatalog(enCatalog);
    } else {
      // Vietnamese loads on demand; English shows until it arrives.
      void import('./catalog-vi').then((vi) => {
        if (!cancelled) setCatalog(vi as unknown as Catalog);
      });
    }
    document.documentElement.lang = locale;
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    writePref('lang', l);
    setLocaleState(l);
  }, []);

  const value = useMemo(() => ({ locale, setLocale, t: makeTranslate(catalog) }), [locale, setLocale, catalog]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
