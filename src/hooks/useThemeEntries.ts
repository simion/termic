// Every theme the app can switch to, with its scheme, in one order: System,
// then the dark themes, then the light ones, each run sorted by name. Shared
// by the command palette's theme list and Settings > Appearance, so the two
// never disagree about what exists. An import already saved as a copy is left
// out: the copy is listed under the same name.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePrefs, type BuiltinThemeMode, type ThemeMode } from "@/store/prefs";
import { copyIdOf } from "@/lib/customTheme";

export type ThemeEntry = { id: ThemeMode; label: string; scheme: "system" | "dark" | "light"; imported?: boolean };

const SCHEME_RANK: Record<ThemeEntry["scheme"], number> = { system: 0, dark: 1, light: 2 };

// auto/light/dark are common words and translate; the rest are proper-noun
// theme names, the same in every language.
const THEME_LABELS: Record<Exclude<BuiltinThemeMode, "auto" | "light" | "dark">, string> = {
  claude: "Claude",
  solarized: "Solarized",
  cobalt: "Cobalt",
  matrix: "Matrix",
  rosepine: "Rosé Pine",
  monokai: "Monokai",
};
const THEME_ORDER: BuiltinThemeMode[] = ["auto", "light", "dark", "claude", "solarized", "cobalt", "matrix", "rosepine", "monokai"];

export function useThemeEntries(): ThemeEntry[] {
  const { t } = useTranslation("dialogs");
  const customThemes = usePrefs(s => s.customThemes);
  const importedThemes = usePrefs(s => s.importedThemes);
  // `t` is a dep so a language switch recomputes the built-in labels.
  return useMemo(() => {
    const builtinLabel = (m: BuiltinThemeMode) =>
      m === "auto" ? t("commandPalette.themeAuto")
      : m === "light" ? t("commandPalette.themeLight")
      : m === "dark" ? t("commandPalette.themeDark")
      : THEME_LABELS[m];
    const entries: ThemeEntry[] = [
      ...THEME_ORDER.map(m => ({
        id: m as ThemeMode, label: builtinLabel(m),
        scheme: m === "auto" ? "system" as const : m === "light" ? "light" as const : "dark" as const,
      })),
      ...customThemes.map(th => ({ id: th.id as ThemeMode, label: th.name, scheme: th.colorScheme })),
      ...importedThemes
        .filter(th => !customThemes.some(c => c.id === copyIdOf(th.id)))
        .map(th => ({ id: th.id as ThemeMode, label: th.name, scheme: th.colorScheme, imported: true })),
    ];
    return entries.sort((a, b) =>
      SCHEME_RANK[a.scheme] - SCHEME_RANK[b.scheme] || a.label.localeCompare(b.label));
  }, [customThemes, importedThemes, t]);
}
