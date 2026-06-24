// In-pane "what should I launch?" picker for an empty right split.
//
// ⌘D opens the right split WITHOUT immediately spawning a shell (the old
// behaviour). Instead the empty pane shows this picker, mirroring the tab
// bar's "+" dropdown: a "New terminal" group (plain Terminal + any custom
// terminals) and a "New agent" group (the visible CLI agents). The first
// row is autoselected; ↑/↓ (or j/k) move, ↵ launches, Esc closes the split.
//
// Once a choice spawns a right tab the launcher unmounts on its own — the
// split now has a tab to render, so WorkspaceView stops showing the picker.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/types";
import { useApp } from "@/store/app";
import { visibleCliIds, isTerminalEntry } from "@/lib/agents";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { cn } from "@/lib/utils";

interface LauncherItem {
  /** "shell" → plain terminal; otherwise a registry agent / custom terminal id. */
  cli: string;
  label: string;
  iconId: string;
  section: "terminal" | "agent";
}

export function SplitLauncher({ ws }: { ws: Workspace }) {
  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const addRightTab = useApp(s => s.addRightTab);
  const addRightAgentTab = useApp(s => s.addRightAgentTab);
  const toggleRightSplit = useApp(s => s.toggleRightSplit);
  const activeWsId = useApp(s => s.activeWorkspaceId);

  // Same lists the "+" dropdown builds (see TabBar), flattened for arrow-key
  // navigation. Plain "Terminal" leads the terminal group.
  const items = useMemo<LauncherItem[]>(() => {
    const visible = visibleCliIds(registry.map(a => a.id), registry, detectedClis);
    const out: LauncherItem[] = [
      { cli: "shell", label: "Terminal", iconId: "shell", section: "terminal" },
    ];
    for (const a of registry.filter(a => isTerminalEntry(a) && !a.disabled)) {
      out.push({ cli: a.id, label: a.display_name, iconId: a.icon_id, section: "terminal" });
    }
    for (const a of registry.filter(a => visible.has(a.id))) {
      out.push({ cli: a.id, label: a.display_name, iconId: a.icon_id, section: "agent" });
    }
    return out;
  }, [registry, detectedClis]);

  const [sel, setSel] = useState(0);
  useEffect(() => { setSel(s => Math.min(Math.max(s, 0), Math.max(0, items.length - 1))); }, [items.length]);

  const rootRef = useRef<HTMLDivElement>(null);
  // Grab keyboard focus when this is the active workspace's launcher — every
  // workspace stays mounted (MainArea visibility toggle), so an unfocused
  // background launcher must NOT steal focus. Re-focus when switching back to
  // this workspace too.
  useEffect(() => {
    if (activeWsId === ws.id) rootRef.current?.focus();
  }, [activeWsId, ws.id]);

  const choose = (it: LauncherItem | undefined) => {
    if (!it) return;
    if (it.cli === "shell") addRightTab(ws.id);
    else addRightAgentTab(ws.id, it.cli);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!items.length) return;
    const k = e.key;
    if (k === "ArrowDown" || (k === "j" && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault(); e.stopPropagation();
      setSel(s => (s + 1) % items.length);
    } else if (k === "ArrowUp" || (k === "k" && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault(); e.stopPropagation();
      setSel(s => (s - 1 + items.length) % items.length);
    } else if (k === "Enter") {
      e.preventDefault(); e.stopPropagation();
      choose(items[sel]);
    } else if (k === "Escape") {
      e.preventDefault(); e.stopPropagation();
      toggleRightSplit(ws.id);
    }
  };

  return (
    <div
      ref={rootRef}
      data-split-launcher=""
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 outline-none pointer-events-none"
    >
      <div className="pointer-events-auto w-full max-w-[260px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] p-1.5 shadow-lg">
        {items.map((it, i) => {
          const firstOfSection = i === 0 || items[i - 1].section !== it.section;
          return (
            <div key={`${it.section}:${it.cli}`}>
              {firstOfSection && (
                <div className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--color-fg-faint)]">
                  {it.section === "terminal" ? "New terminal" : "New agent"}
                </div>
              )}
              <button
                onMouseMove={() => setSel(i)}
                onClick={() => choose(it)}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
                  i === sel
                    ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
                    : "text-[var(--color-fg-dim)]",
                )}
              >
                <span className={cn("shrink-0", CLI_BRAND_COLOR[it.iconId] || "text-[var(--color-fg-dim)]")}>
                  <CliIcon cli={it.iconId} className="h-4 w-4" />
                </span>
                <span className="truncate">{it.label}</span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] text-[var(--color-fg-faint)]">
        <kbd className="font-sans">↑↓</kbd> navigate · <kbd className="font-sans">↵</kbd> launch · <kbd className="font-sans">esc</kbd> close
      </div>
    </div>
  );
}
