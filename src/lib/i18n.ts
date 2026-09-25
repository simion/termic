// App-wide internationalization (i18next + react-i18next).
//
// Languages are bundled (no network loading): every locale is a TS module
// under src/locales/<lang>/<namespace>.ts, aggregated by src/locales/<lang>.ts.
// The active language is a user pref (localStorage `uiLanguage`, see
// store/prefs.ts) with three values:
//   - "system" (default): follow the OS language, Chinese -> zh-CN, else en
//   - "en" / "zh-CN": explicit picks
//
// Usage in a component:
//   import { useTranslation } from "react-i18next";
//   const { t } = useTranslation("settings");          // one namespace
//   t("general.language")                               // dotted key
//   t("general.itemCount", { count: n })                // {{count}} interpolation
// Shared one-word labels (OK/Cancel/...) live in the "common" namespace,
// which is the default: useTranslation() with no argument.
//
// Outside React (stores, lib, hooks) import { i18n } and call i18n.t(...)
// with the fully-qualified "namespace:key". Prefer passing t() down from a
// component where possible, so the text re-renders on a language switch.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "@/locales/en";
import zhCN from "@/locales/zh-CN";

export const LS_LANGUAGE = "uiLanguage";

export type LanguagePref = "system" | "en" | "zh-CN";
export type ResolvedLanguage = "en" | "zh-CN";

/** Narrow an untrusted localStorage string to a LanguagePref. */
export function parseLanguagePref(raw: string | null | undefined): LanguagePref {
  return raw === "en" || raw === "zh-CN" ? raw : "system";
}

/** Resolve a pref to a concrete locale. "system" follows navigator.language:
 *  any Chinese variant maps to zh-CN, everything else to English. */
export function resolveLanguage(pref: LanguagePref): ResolvedLanguage {
  if (pref === "en" || pref === "zh-CN") return pref;
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Read the stored pref directly. i18n initializes before the prefs store
 *  module (main.tsx import order), so it cannot read the store here. */
function initialLanguage(): ResolvedLanguage {
  let raw: string | null = null;
  try { raw = localStorage.getItem(LS_LANGUAGE); } catch {}
  return resolveLanguage(parseLanguagePref(raw));
}

export const NAMESPACES = [
  "common",   // shared one-word labels (OK/Cancel/Save...), the defaultNS
  "sidebar",  // src/components/sidebar/*
  "settings", // src/components/settings/*
  "dialogs",  // src/components/dialogs/*
  "task",     // src/components/task/* core panes (tabs, terminals, file tree)
  "panels",   // src/components/task/* content panels (diff, git, PR, race)
  "chrome",   // root src/components/*, views, ui primitives
  "backend",  // user-visible strings from stores/hooks/lib (toasts, notifications)
] as const;
export type Namespace = typeof NAMESPACES[number];

void i18n.use(initReactI18next).init({
  // Each language module's top-level keys ARE the namespaces.
  resources: { en, "zh-CN": zhCN },
  lng: initialLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: [...NAMESPACES],
  interpolation: {
    escapeValue: false, // React already escapes interpolated values
  },
  react: {
    // No Suspense: resources are bundled, so a translation is always
    // available synchronously. Suspending would blank the UI for a frame.
    useSuspense: false,
  },
  // A missing key renders the key itself in dev, which is the signal a
  // string was extracted without a locale entry. Parity between en and
  // zh-CN is enforced by src/locales/parity.test.ts.
  returnNull: false,
});

/** Switch the active language at runtime. The prefs store's setter calls
 *  this; every mounted useTranslation subscriber re-renders. Also swaps the
 *  <html lang> attribute so WKWebView's font fallback picks proper CJK
 *  faces for Chinese text. */
export function applyLanguage(pref: LanguagePref) {
  const resolved = resolveLanguage(pref);
  if (i18n.language !== resolved) void i18n.changeLanguage(resolved);
  if (typeof document !== "undefined") document.documentElement.lang = resolved;
}

// Set the lang attribute for first paint (module load runs before render).
if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

export { i18n };
