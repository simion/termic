// The theme picker: one icon in the sidebar footer, a hover dropdown of every
// palette behind it.
//
// Extracted from UnifiedBar when it moved out of the title bar (GH #280): the
// profile chip took that space, and a set-once preference belongs with the
// other set-once affordances in the footer rather than on the bar you drive
// agents from.

import { useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Sun, Moon, Monitor, Code2, Sunrise, Droplet, Binary, Flower2 } from "lucide-react";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import { Check, Palette, FolderOpen } from "lucide-react";
import { openPath, themesDir } from "@/lib/ipc";

/** Every row in the theme dropdown. Icons sit flush against the padding:
 *  a leading checkmark column (even a transparent one) indents every label
 *  to pay for the one active row, so the tick moved to the trailing edge
 *  where it only takes space when it exists. */
const THEME_ROW =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13.5px] text-[var(--color-fg)] whitespace-nowrap hover:bg-[var(--color-hover)]";
/** The tick alone is easy to miss at 14px, so the active row also tints its
 *  icon + label. Two signals, no extra layout. */
const THEME_ROW_ACTIVE = "font-medium text-[var(--color-accent)]";

export function ThemePicker() {
  const { t } = useTranslation("chrome");
  // Self-contained: it reads and writes the one preference it is about.
  // It used to take these as props from the title bar, which is why moving it
  // to the sidebar footer would otherwise have meant threading theme state
  // through a component that has nothing to do with themes.
  //
  // `auto` drives the small "A" badge so the user can tell "follow OS" from an
  // explicit light/dark. The dark-family palettes (Espresso, Solarized, ...)
  // can only ever come from an explicit pick, since the OS cannot infer them.
  const themeMode = usePrefs(s => s.themeMode);
  const setThemeMode = usePrefs(s => s.setThemeMode);
  // Resolved to Sun/Moon rather than a generic Monitor: in auto mode the icon
  // shows what the OS actually resolved to, which is the thing you want to
  // know at a glance.
  const Icon = (themeMode === "light" || (themeMode === "auto" && resolveTheme(themeMode) === "light"))
    ? Sun : Moon;
  type Item = { id: import("@/store/prefs").ThemeMode; label: string; icon: typeof Sun };
  const items: Item[] = [
    // "System" = follow OS prefers-color-scheme. Stored as `auto` for backward
    // compatibility with existing localStorage values.
    // Palette names (Claude, Dark+, Cobalt, ...) are proper nouns and stay
    // English in every locale; only the two generic modes translate.
    { id: "auto",      label: t("themePicker.system"), icon: Monitor },
    { id: "light",     label: t("themePicker.light"),  icon: Sun },
    { id: "claude",    label: "Claude",         icon: Moon },
    { id: "dark",      label: "Dark+",          icon: Code2 },
    { id: "solarized", label: "Solarized Dark", icon: Sunrise },
    { id: "cobalt",    label: "Cobalt",         icon: Droplet },
    { id: "matrix",    label: "Matrix",         icon: Binary },
    { id: "rosepine",  label: "Rosé Pine",      icon: Flower2 },
  ];
  // Plain DOM dropdown — Radix HoverCard's pointer-tracking kept
  // closing on item click (the theme-change re-render storm triggers
  // pointer-out detection somewhere internally). Manual implementation
  // gives us absolute control: opens on trigger hover, stays open until
  // outside click or cursor leaves the WHOLE region (trigger + content)
  // for closeDelayMs. Item clicks never close it — user can cycle
  // through System / Light / Dark to compare freely.
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Custom theme files (~/.config/termic/themes/*.json). Refetched on every
  // trigger hover — that's the "hot reload": edit file, reopen picker.
  const customThemes = usePrefs(s => s.customThemes);
  const cancelClose = () => {
    if (closeTimerRef.current) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 200);
  };
  // Outside click closes immediately.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={() => {
        cancelClose(); setOpen(true);
        void usePrefs.getState().loadCustomThemes();
      }}
      onMouseLeave={scheduleClose}
    >
      <Button size="icon" variant="icon" onClick={() => setOpen(v => !v)}>
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
      {open && (
        <div
          className={cn(
            // UPWARD. This lives in the sidebar footer, at the bottom of the
            // window, so a panel hanging below the trigger opens off-screen.
            // It opened downward while it sat in the title bar.
            "absolute bottom-full left-0 z-50 mb-1 min-w-[170px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-1 shadow-xl",
            // Bottom-anchored, so the list is built from the trigger OUTWARD:
            // reversing puts the first item nearest the cursor, which is where
            // a menu growing upward is read from.
            "flex flex-col-reverse",
          )}
        >
          {items.map(it => {
            const Ic = it.icon;
            const active = it.id === themeMode;
            return (
              <button
                key={it.id}
                onClick={() => setThemeMode(it.id)}
                className={cn(THEME_ROW, active && THEME_ROW_ACTIVE)}
              >
                <Ic className={cn("h-4 w-4 shrink-0", active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]")} />
                <span>{it.label}</span>
                {active && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
              </button>
            );
          })}
          {customThemes.length > 0 && (
            <div className="my-1 border-t border-[var(--color-border-soft)]" />
          )}
          {customThemes.map(th => {
            const active = th.id === themeMode;
            return (
              <button
                key={th.id}
                onClick={() => setThemeMode(th.id)}
                className={cn(THEME_ROW, active && THEME_ROW_ACTIVE)}
              >
                <Palette className={cn("h-4 w-4 shrink-0", active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]")} />
                <span className="truncate">{th.name}</span>
                {active && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
              </button>
            );
          })}
          <div className="my-1 border-t border-[var(--color-border-soft)]" />
          {/* The discovery affordance when no theme files exist yet: the
              folder ships a README + a copyable example. Label names the
              concept, title says what clicking does (the icon alone carries
              too little). */}
          <button
            title={t("themePicker.openThemesFolder")}
            onClick={() => { themesDir().then(openPath).catch(() => {}); }}
            className={THEME_ROW}
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
            <span>{t("themePicker.customThemes")}</span>
          </button>
          {/* One-time tip: agent CLIs persist their own theme. We set
              COLORFGBG on spawn so most TUIs auto-pick, but claude and
              codex also expose a `/theme` slash command that writes to
              ~/.claude / ~/.codex and persists across launches. Surfacing
              it here so users find it the first time they switch themes.
              Named agents only: an agent listed here that does NOT have
              the command sends the user looking for one. */}
          {/* `mb-1`, not `mt-1`: `flex-col-reverse` mirrors the ORDER but not
              the margins, so the spacing has to be written for where the block
              actually lands (visually the top of an upward menu). */}
          <div className="mb-1 border-t border-[var(--color-border-soft)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
            <Trans
              t={t}
              i18nKey="themePicker.agentThemeTip"
              components={{ code: <span className="mono text-[var(--color-fg-dim)]" /> }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

