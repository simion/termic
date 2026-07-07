// Read-only keyboard-shortcuts cheat sheet (opened from the sidebar footer).
// A searchable, grouped list of every binding. Editing lives in Settings →
// Shortcuts; the "Edit" button in the header closes this and jumps there.

import { useEffect, useMemo, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Command, Search, X, Pencil } from "lucide-react";
import {
  SHORTCUT_DEFS,
  GROUP_ORDER,
  bindingGlyphs,
  IS_MAC,
  type ShortcutGroup,
  type ShortcutId,
} from "@/lib/shortcuts";

// Terminal copy/paste are native (⌘C / ⌘V) on macOS and only wired on
// Linux/Windows, so omit them from the macOS cheat sheet.
const HIDDEN_ON_MAC: Set<ShortcutId> = IS_MAC
  ? new Set<ShortcutId>(["terminal-copy", "terminal-paste"])
  : new Set<ShortcutId>();

export function ShortcutsHelpDialog() {
  const open = useUI(s => s.shortcutsHelpOpen);
  const close = useUI(s => s.closeShortcutsHelp);
  const openSettings = useApp(s => s.openSettings);
  const shortcuts = usePrefs(s => s.shortcuts);
  const [query, setQuery] = useState("");

  // Reset the filter each time the sheet opens so it never reopens
  // pre-filtered from a prior visit.
  useEffect(() => { if (open) setQuery(""); }, [open]);

  // Group → matching defs, filtered by the search query (label + hint).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { group: ShortcutGroup; defs: typeof SHORTCUT_DEFS }[] = [];
    for (const group of GROUP_ORDER) {
      const defs = SHORTCUT_DEFS.filter(d =>
        d.group === group &&
        !HIDDEN_ON_MAC.has(d.id) &&
        (!q || d.label.toLowerCase().includes(q) || (d.hint ?? "").toLowerCase().includes(q)),
      );
      if (defs.length) out.push({ group, defs });
    }
    return out;
  }, [query]);

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
          <span className="text-base font-medium">Keyboard shortcuts</span>
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
            Edit
          </button>
          <button
            onClick={close}
            className="rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            aria-label="Close"
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
          placeholder="Search shortcuts…"
          autoFocus
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-2.5 pl-9 pr-3 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      {/* Grouped list */}
      <div className="mt-3 flex max-h-[58vh] flex-col gap-5 overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <div className="px-1 py-6 text-center text-[12.5px] text-[var(--color-fg-faint)]">
            No shortcuts match “{query}”.
          </div>
        ) : groups.map(({ group, defs }) => (
          <div key={group} className="flex flex-col">
            <div className="mb-1 px-1 text-[12px] text-[var(--color-fg-dim)]">{group}</div>
            {defs.map(def => (
              <div key={def.id} className="flex items-center justify-between gap-4 px-1 py-2">
                <span className="min-w-0 truncate text-[13.5px] text-[var(--color-fg)]">{def.label}</span>
                <div className="flex shrink-0 items-center gap-1">
                  {bindingGlyphs(shortcuts[def.id]).map((g, i) => <KeyCap key={i} glyph={g} />)}
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
