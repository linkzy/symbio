// The interface's language: its text per language (i18n/en.ts, the base, and its translations), the
// one in use (chosen in Settings → This computer → Appearance, or the browser's), and t() to look
// text up. English stands in for anything not translated yet. Agents' briefs and Symbio's messages
// to agents stay in English: they're instructions for models.

import { useEffect, useState } from "react";
import { en, type MessageKey } from "./i18n/en.js";
import { ptBR } from "./i18n/pt-BR.js";

export type { MessageKey };
export type Locale = "en" | "pt-BR";

export const LOCALES: { id: Locale; label: string; native: string }[] = [
  { id: "en", label: "English", native: "English" },
  { id: "pt-BR", label: "Portuguese (Brazil)", native: "Português (Brasil)" },
];

const KEY = "symbio:locale";
const EVENT = "symbio:locale-changed";

type Dict = Partial<Record<MessageKey, string>>;

export const DICTS: Record<Locale, Dict> = { en, "pt-BR": ptBR };

/** The browser's language, when Symbio has it (any Portuguese counts as Brazil's). */
export function browserLocale(languages: readonly string[] = typeof window !== "undefined" && typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : []): Locale {
  for (const lang of languages) {
    const l = lang.toLowerCase();
    const exact = LOCALES.find((x) => x.id.toLowerCase() === l);
    if (exact) return exact.id;
    if (l.startsWith("pt")) return "pt-BR";
    if (l.startsWith("en")) return "en";
  }
  return "en";
}

export function currentLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (LOCALES.some((l) => l.id === saved)) return saved as Locale;
  } catch {}
  return browserLocale();
}

export function applyLocale(locale = currentLocale()) {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export function setLocale(locale: Locale) {
  try {
    localStorage.setItem(KEY, locale);
  } catch {}
  applyLocale(locale);
  if (typeof dispatchEvent !== "undefined") dispatchEvent(new Event(EVENT));
}

function lookup(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  let text = DICTS[locale][key] ?? en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

/** Text outside React components (the language now). */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return lookup(currentLocale(), key, params);
}

export function useI18n() {
  const [locale, set] = useState<Locale>(currentLocale);
  useEffect(() => {
    const update = () => set(currentLocale());
    addEventListener(EVENT, update);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) {
        applyLocale();
        update();
      }
    };
    addEventListener("storage", onStorage);
    return () => {
      removeEventListener(EVENT, update);
      removeEventListener("storage", onStorage);
    };
  }, []);
  const translate = (key: MessageKey, params?: Record<string, string | number>) => lookup(locale, key, params);
  return { locale, setLocale, t: translate };
}
