// The theme picker: one icon in the sidebar footer that opens the command
// palette's theme list (every built-in, theme file and Ghostty / Warp import,
// with a live preview and a dark / light filter). It used to open a hover
// menu of its own, which only knew the built-ins and the theme files.
//
// Extracted from UnifiedBar when it moved out of the title bar (GH #280): the
// profile chip took that space, and a set-once preference belongs with the
// other set-once affordances in the footer rather than on the bar you drive
// agents from.

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sun, Moon } from "lucide-react";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { bindingText } from "@/lib/shortcuts";

export function ThemePicker() {
  const { t } = useTranslation("chrome");
  const themeMode = usePrefs(s => s.themeMode);
  // Resolved to Sun/Moon rather than a generic Monitor: in auto mode the icon
  // shows what the OS actually resolved to, which is the thing you want to
  // know at a glance.
  const Icon = resolveTheme(themeMode) === "light" ? Sun : Moon;
  const binding = usePrefs(s => s.shortcuts["change-theme"]);
  const label = `${t("themePicker.changeTheme")}${binding ? ` (${bindingText(binding)})` : ""}`;

  // a toggle on pointerdown, for the reason CommandPaletteButton spells out:
  // Radix closes the palette on document pointerdown before onClick fires,
  // so a click handler would always see it closed and reopen it
  const handledRef = useRef(false);
  const toggle = () => {
    const ui = useUI.getState();
    if (ui.commandPaletteOpen) ui.closeCommandPalette();
    else ui.openCommandPalette("theme");
  };
  return (
    <Tip content={label}>
      <Button
        size="icon"
        variant="icon"
        data-testid="theme-picker"
        aria-label={label}
        onPointerDown={(e) => { if (e.button !== 0) return; handledRef.current = true; toggle(); }}
        onClick={() => {
          if (handledRef.current) { handledRef.current = false; return; }
          toggle();
        }}
      >
        <span className="relative inline-flex h-[18px] w-[18px] items-center justify-center">
          <Icon className="h-[18px] w-[18px]" />
          {themeMode === "auto" && (
            // Tiny "A" badge in the bottom-right corner to signal that
            // the visible Sun/Moon is the OS-resolved theme, not an
            // explicit user choice. Outline matches button bg so it
            // reads as a sticker on top of the icon, not part of it.
            <span
              className="absolute -bottom-1 -right-1 flex h-[10px] w-[10px] items-center justify-center rounded-full bg-[var(--color-accent)] text-[7px] font-bold leading-none text-[var(--color-accent-fg)] ring-1 ring-[var(--color-bg)]"
              aria-label={t("themePicker.autoBadge")}
            >A</span>
          )}
        </span>
      </Button>
    </Tip>
  );
}
