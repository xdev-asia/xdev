import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import en from "./en.json";
import vi from "./vi.json";

export type Locale = "en" | "vi";
type Vars = Record<string, string | number>;

const dictionaries: Record<Locale, Record<string, string>> = { en, vi };
const STORAGE_KEY = "xdev-locale";

export function detectLocale(lang: string | undefined): Locale {
  return lang?.toLowerCase().startsWith("vi") ? "vi" : "en";
}

export function translate(locale: Locale, key: string, vars?: Vars): string {
  const dict = dictionaries[locale];
  // English needs a singular form ("1 doc"); Vietnamese has none, so its `.one` keys just repeat the plain text.
  const template = (vars?.count === 1 ? dict[`${key}.one`] : undefined) ?? dict[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (vars && name in vars ? String(vars[name]) : match));
}

// Storage can throw (private mode, blocked site data); the app must still start.
function storedLocale(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "en" || value === "vi" ? value : null;
  } catch {
    return null;
  }
}

function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // The choice just won't survive a restart.
  }
}

export type I18n = { locale: Locale; setLocale(l: Locale): void; t(key: string, vars?: Vars): string };

export const I18nContext = createContext<I18n | null>(null);

export function I18nProvider(props: { children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => storedLocale() ?? detectLocale(navigator.language));

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    storeLocale(l);
    setLocaleState(l);
  }, []);

  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );
  return createElement(I18nContext.Provider, { value }, props.children);
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
