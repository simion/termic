// Read-only keyboard-shortcuts cheat sheet (opened from the sidebar footer).
// A searchable, grouped list of every binding. Editing lives in Settings →
// Shortcuts; the "Edit" button in the header closes this and jumps there.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Command, Search, X, Pencil } from "lucide-react";
import {
  SHORTCUT_DEFS,
  FIXED_SHORTCUTS,
  GROUP_ORDER,
  bindingGlyphs,
  doubleShiftLabel,
  ctrlTabLabel,
  IS_MAC,
  type ShortcutGroup,
  type ShortcutId,
} from "@/lib/shortcuts";
import { codeIntelName } from "@/lib/lsp/featureName";

/** One printed line: a label, the keys, and (for the fixed ones) why there is
 *  no recorder next to it. */
interface Row {
  id: string;
  label: string;
  glyphs: string[];
  fixed: string | null;
}

/** The "Code navigation" group is named after the feature, which is itself
 *  named after what it is currently doing (lib/lsp/featureName.ts). */
export function groupLabel(group: ShortcutGroup, typeChecking: boolean): string {
  return group === "Code navigation" ? codeIntelName(typeChecking) : group;
}

// Terminal copy/paste are native (⌘C / ⌘V) on macOS and only wired on
// Linux/Windows, so omit them from the macOS cheat sheet.
const HIDDEN_ON_MAC: Set<ShortcutId> = IS_MAC
  ? new Set<ShortcutId>(["terminal-copy", "terminal-paste"])
  : new Set<ShortcutId>();

export function ShortcutsHelpDialog() {
  const { t } = useTranslation("dialogs");
  const open = useUI(s => s.shortcutsHelpOpen);
  const close = useUI(s => s.closeShortcutsHelp);
  const openSettings = useApp(s => s.openSettings);
  const shortcuts = usePrefs(s => s.shortcuts);
  const typeChecking = usePrefs(s => s.codeIntelDiagnostics);
  const doubleShiftMode = usePrefs(s => s.doubleShiftMode);
  const ctrlTabMode = usePrefs(s => s.ctrlTabMode);
  const [query, setQuery] = useState("");

  // Reset the filter each time the sheet opens so it never reopens
  // pre-filtered from a prior visit.
  useEffect(() => { if (open) setQuery(""); }, [open]);

  // Group → matching rows, filtered by the search query (label + hint).
  //
  // Two sources: the rebindable defs, and the handful of gestures that cannot
  // be expressed as a chord (double-Shift). Both are things a reader is here
  // to FIND, so the search has to reach both; only the rebindable half has a
  // binding to print, so each row carries its own glyphs.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (label: string, hint?: string) =>
      !q || label.toLowerCase().includes(q) || (hint ?? "").toLowerCase().includes(q);
    const out: { group: ShortcutGroup; rows: Row[] }[] = [];
    for (const group of GROUP_ORDER) {
      const rows: Row[] = [
        ...SHORTCUT_DEFS
          .filter(d => d.group === group && !HIDDEN_ON_MAC.has(d.id) && matches(d.label, d.hint))
          .map(d => ({
            id: d.id, label: d.label, glyphs: bindingGlyphs(shortcuts[d.id]), fixed: null,
          })),
        // A gesture switched off in Settings is not a shortcut this window
        // has: printing it would be an instruction that does nothing. It is
        // dropped rather than greyed, because this sheet is the answer to
        // "what can I press", and the Shortcuts page is where its state and
        // the way back on both live.
        ...FIXED_SHORTCUTS
          .filter(f => f.group === group && matches(f.label, f.hint))
          .filter(f => (f.control === "double-shift" ? doubleShiftMode !== "off" : true))
          .filter(f => (f.control === "ctrl-tab" ? ctrlTabMode !== "off" : true))
          // The row says WHICH double tap, because the answer is a setting:
          // printing "Double tap, left" to somebody who chose either Shift
          // describes a restriction they turned off.
          .map(f => ({
            id: f.id,
            label: f.label,
            glyphs: f.glyphs,
            // The chosen mode's own label, which is the same string the
            // Shortcuts page offers: this sheet cannot be rebound from, so it
            // prints what the gesture currently IS.
            fixed: f.control === "double-shift" ? doubleShiftLabel(doubleShiftMode)
              : f.control === "ctrl-tab" ? ctrlTabLabel(ctrlTabMode)
              : f.fixedReason,
          })),
      ];
      if (rows.length) out.push({ group, rows });
    }
    return out;
  }, [query, shortcuts, doubleShiftMode, ctrlTabMode]);

  function edit() {
    close();
    openSettings("shortcuts");
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      className="max-w-2xl"
      hideClose
    >
      {/* Header: ⌘ glyph + title on the left, Edit + Close on the right. */}
      <div
        data-tauri-drag-region
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        className="flex items-center justify-between gap-4 select-none"
      >
        <div className="flex items-center gap-2">
          <Command className="h-4 w-4 text-[var(--color-fg-dim)]" />
          <span className="text-base font-medium">{t("shortcutsHelp.title")}</span>
        </div>
        <div
          data-tauri-drag-region="false"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className="flex items-center gap-1"
        >
          <button
            onClick={edit}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[12.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t("common:edit")}
          </button>
          <button
            onClick={close}
            className="rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            aria-label={t("common:close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-fg-faint)]" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("shortcutsHelp.searchPlaceholder")}
          autoFocus
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-2.5 pl-9 pr-3 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      {/* Grouped list */}
      <div className="mt-3 flex max-h-[58vh] flex-col gap-5 overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <div className="px-1 py-6 text-center text-[12.5px] text-[var(--color-fg-faint)]">
            {t("shortcutsHelp.noMatch", { query })}
          </div>
        ) : groups.map(({ group, rows }) => (
          <div key={group} className="flex flex-col">
            <div className="mb-1 px-1 text-[12px] text-[var(--color-fg-dim)]">
              {groupLabel(group, typeChecking)}
            </div>
            {rows.map(row => (
              <div
                key={row.id}
                data-testid="shortcut-row"
                data-shortcut-id={row.id}
                className="flex items-center justify-between gap-4 px-1 py-2"
              >
                <span className="min-w-0 truncate text-[13.5px] text-[var(--color-fg)]">{row.label}</span>
                <div className="flex shrink-0 items-center gap-1">
                  {/* Why it has no recorder, said in one word rather than by
                      leaving the reader to wonder why this row is different. */}
                  {row.fixed && (
                    <span className="text-[11px] text-[var(--color-fg-faint)]">{row.fixed}</span>
                  )}
                  {row.glyphs.map((g, i) => <KeyCap key={i} glyph={g} />)}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </AppDialog>
  );
}

/** A single keycap rendered with the raw glyph (⌘ ⌥ ⇧, arrows, letters,
 *  punctuation) — the compact cheat-sheet look, no spelled-out words. */
function KeyCap({ glyph }: { glyph: string }) {
  return (
    <kbd className="inline-flex h-7 min-w-[28px] items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 font-mono text-[12px] leading-none text-[var(--color-fg-dim)]">
      {glyph}
    </kbd>
  );
}
