// Workspace view: TabBar + per-tab content. Optional horizontal split puts a
// scratch shell terminal on the bottom half so the user can run git/grep/etc.
// without leaving the agent up top.
//
// Per-tab content stays mounted across tab switches (we toggle visibility
// instead of unmount) — terminals MUST keep their xterm instances alive.

import { lazy, Suspense, useEffect, useRef } from "react";
import type { Workspace } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { usePrefs, currentTerminalTheme } from "@/store/prefs";
import { TabBar } from "./TabBar";
import { TerminalPane, FooterBar } from "./TerminalPane";
import { AuxTerminal } from "./AuxTerminal";
import { X, Plus, TerminalSquare, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
const EditorPane = lazy(() => import("./EditorPane").then(m => ({ default: m.EditorPane })));
const DiffPane   = lazy(() => import("./DiffPane").then(m => ({ default: m.DiffPane })));

const DEFAULT_SPLIT_HEIGHT = 240;
const MIN_HEIGHT = 80;

function BottomTabPill({ title, active, onSelect, onClose }: {
  title: string; active: boolean; canClose?: boolean; onSelect: () => void; onClose: () => void;
}) {
  // Geometry mirrors TabBar.tsx's TabPill: h-7 / rounded-md / text-[13.5px]
  // / h-4 icons. So the split-strip below the agent terminal feels like the
  // *same* tab system as the main strip up top, not a separate mini-strip.
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13.5px] transition-colors max-w-[220px]",
        active
          ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
      )}
    >
      <TerminalSquare className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
      <span className="truncate">{title}</span>
      {/* Close button always visible — closing the last shell tab
          also collapses the split (handled by the store's
          closeBottomTab → toggleSplit fallback if count hits 0). */}
      <button
        title="Close shell"
        className="ml-0.5 rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      ><X className="h-3 w-3" /></button>
    </div>
  );
}

export function WorkspaceView({ ws }: { ws: Workspace }) {
  const ensureDefaultTab = useApp(s => s.ensureDefaultTab);
  const tabs = useWorkspaceTabs(ws.id);
  const activeId = useActiveTabId(ws.id);
  const split        = useApp(s => !!s.terminalSplit[ws.id]);
  const splitHeight  = useApp(s => s.terminalSplitHeight[ws.id] ?? DEFAULT_SPLIT_HEIGHT);
  const setSplitHeight = useApp(s => s.setTerminalSplitHeight);
  const collapsed    = useApp(s => !!s.terminalSplitCollapsed[ws.id]);
  const toggleCollapsed = useApp(s => s.toggleTerminalSplitCollapsed);
  const bottomTabs   = useApp(s => s.bottomTabs[ws.id]);
  const activeBottom = useApp(s => s.activeBottomTab[ws.id]);
  const addBottomTab = useApp(s => s.addBottomTab);
  const closeBottomTab = useApp(s => s.closeBottomTab);
  const setActiveBottom = useApp(s => s.setActiveBottomTab);

  // Subscribe to themeMode so the terminals-area bg recomputes when the
  // user switches themes — currentTerminalTheme() reads the live store but
  // doesn't trigger a re-render on its own.
  usePrefs(s => s.themeMode);
  const xtermBg = currentTerminalTheme().background as string;

  useEffect(() => { ensureDefaultTab(ws.id, ws.cli); }, [ws.id, ws.cli, ensureDefaultTab]);

  // Seed the first bottom tab the moment the split opens, so the user has
  // something to type into immediately (no empty state).
  useEffect(() => {
    if (split && (!bottomTabs || bottomTabs.length === 0)) addBottomTab(ws.id);
  }, [split, bottomTabs, ws.id, addBottomTab]);

  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabBar ws={ws} />
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
        {/* Top: tab content (agent terminal / editor / diff). */}
        <div className="relative min-h-0 flex-1">
          {tabs.map(t => (
            <div
              key={t.id}
              className="absolute inset-0"
              style={{ visibility: t.id === activeId ? "visible" : "hidden", zIndex: t.id === activeId ? 1 : 0 }}
            >
              {t.type === "terminal" && <TerminalPane ws={ws} tab={t} active={t.id === activeId} />}
              {t.type === "edit"     && <Suspense fallback={null}><EditorPane ws={ws} tab={t} /></Suspense>}
              {t.type === "diff"     && <Suspense fallback={null}><DiffPane   ws={ws} tab={t} /></Suspense>}
            </div>
          ))}
        </div>

        {/* Optional bottom split: drag handle + tab strip + scratch shells. */}
        {split && (
          <>
            <div
              data-bottom-split=""
              className="relative shrink-0 flex-col bg-[var(--color-bg-1)] border-t border-[var(--color-border-soft)] flex"
              // h-9 tab strip = 36px; when collapsed, panel shrinks to the
              // strip and the terminals div is display:none'd below. Shells
              // stay mounted, so re-expanding doesn't respawn anything.
              style={{ height: collapsed ? 36 : splitHeight }}
            >
              {/* Shared 1px handle on the top edge — matches the sidebar /
                  right-panel / footer handles instead of the old fat 6px bar.
                  Hidden when collapsed; nothing to resize to. */}
              {!collapsed && (
                <ResizeHandle
                  direction="y"
                  className="top-0"
                  onDrag={(dy) => {
                    const containerH = containerRef.current?.clientHeight ?? 600;
                    const cur = useApp.getState().terminalSplitHeight[ws.id] ?? DEFAULT_SPLIT_HEIGHT;
                    const next = Math.round(Math.max(MIN_HEIGHT, Math.min(containerH - MIN_HEIGHT, cur - dy)));
                    setSplitHeight(ws.id, next);
                  }}
                />
              )}
              {/* Tab strip: matches the main TabBar's geometry — h-9 / px-2
                  / gap-0.5 — so the split-bottom feels like the same UI
                  primitive, not a smaller cousin. */}
              <div className={cn(
                "flex h-9 shrink-0 items-center gap-0.5 bg-[var(--color-bg-1)] px-2",
                // Strip's border-b separates strip-from-terminals when expanded.
                // When collapsed there are no terminals below — FooterBar's own
                // border-t becomes the only divider, and stacking both produces
                // a visible double line.
                !collapsed && "border-b border-[var(--color-border-soft)]",
              )}>
                {(bottomTabs || []).map(t => (
                  <BottomTabPill
                    key={t.id}
                    title={t.title}
                    active={t.id === activeBottom}
                    canClose={(bottomTabs?.length ?? 0) > 1}
                    onSelect={() => setActiveBottom(ws.id, t.id)}
                    onClose={() => closeBottomTab(ws.id, t.id)}
                  />
                ))}
                <button
                  title="New shell tab"
                  onClick={() => addBottomTab(ws.id)}
                  className="ml-1 rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                ><Plus className="h-4 w-4" /></button>
                <button
                  title={collapsed ? "Expand terminal" : "Collapse terminal"}
                  onClick={() => toggleCollapsed(ws.id)}
                  className="ml-auto rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
                >
                  {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              </div>
              {/* Terminals: render each tab as an AuxTerminal kept mounted with
                  visibility toggle, same as the main tabs — switching tabs must
                  not respawn the shell. */}
              <div
                className="relative min-h-0 flex-1"
                // display:none keeps the AuxTerminals in the React tree (so
                // PTYs + xterm instances stay alive) but stops the WebGL
                // render loop while hidden. ResizeObserver inside AuxTerminal
                // fires fit() when we toggle back, so the cell grid recovers.
                //
                // backgroundColor matches xterm's theme bg so the cell-grid
                // remainder (panel height isn't an integer multiple of cell
                // height — there's always a few pixels left under the last
                // row) blends with the terminal instead of showing the
                // chrome's --color-bg-1 as a darker strip.
                style={{ display: collapsed ? "none" : "block", backgroundColor: xtermBg }}
              >
                {(bottomTabs || []).map(t => (
                  <div
                    key={t.id}
                    data-tab-id={t.id}
                    className="absolute inset-0"
                    style={{ visibility: t.id === activeBottom ? "visible" : "hidden", zIndex: t.id === activeBottom ? 1 : 0 }}
                  >
                    <AuxTerminal
                      wsPath={ws.path}
                      active={t.id === activeBottom}
                      // closeBottomTab moves focus to the shell that takes
                      // over (or the main pane if this was the last one),
                      // so Ctrl+D'ing through shells never dumps focus.
                      onExited={() => closeBottomTab(ws.id, t.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {/* Sandbox status row — hoisted out of TerminalPane so it
            sits BELOW the bottom-split (when open) and stays the
            visual bottom of the workspace regardless of which tab
            type is active. Always rendered. */}
        <FooterBar ws={ws} sandboxWarning={null} />
      </div>
    </div>
  );
}
