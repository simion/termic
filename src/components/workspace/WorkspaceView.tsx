// Workspace view: TabBar + per-tab content. Optional horizontal split puts a
// scratch shell terminal on the bottom half so the user can run git/grep/etc.
// without leaving the agent up top.
//
// Per-tab content stays mounted across tab switches (we toggle visibility
// instead of unmount) — terminals MUST keep their xterm instances alive.

import { lazy, Suspense, useEffect, useRef } from "react";
import type { Workspace } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { TabBar } from "./TabBar";
import { TerminalPane } from "./TerminalPane";
import { AuxTerminal } from "./AuxTerminal";
import { X, Plus, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
const EditorPane = lazy(() => import("./EditorPane").then(m => ({ default: m.EditorPane })));
const DiffPane   = lazy(() => import("./DiffPane").then(m => ({ default: m.DiffPane })));

const DEFAULT_SPLIT_HEIGHT = 240;
const MIN_HEIGHT = 80;

function BottomTabPill({ title, active, canClose, onSelect, onClose }: {
  title: string; active: boolean; canClose: boolean; onSelect: () => void; onClose: () => void;
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
      {canClose && (
        <button
          className="ml-0.5 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        ><X className="h-3 w-3" /></button>
      )}
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
  const toggleSplit  = useApp(s => s.toggleTerminalSplit);
  const bottomTabs   = useApp(s => s.bottomTabs[ws.id]);
  const activeBottom = useApp(s => s.activeBottomTab[ws.id]);
  const addBottomTab = useApp(s => s.addBottomTab);
  const closeBottomTab = useApp(s => s.closeBottomTab);
  const setActiveBottom = useApp(s => s.setActiveBottomTab);

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
              className="relative shrink-0 flex-col bg-[var(--color-bg-1)] border-t border-[var(--color-border-soft)] flex"
              style={{ height: splitHeight }}
            >
              {/* Shared 1px handle on the top edge — matches the sidebar /
                  right-panel / footer handles instead of the old fat 6px bar. */}
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
              {/* Tab strip: matches the main TabBar's geometry — h-9 / px-2
                  / gap-0.5 — so the split-bottom feels like the same UI
                  primitive, not a smaller cousin. */}
              <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2">
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
                  title="Close split terminal"
                  onClick={() => toggleSplit(ws.id)}
                  className="ml-auto rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
                ><X className="h-4 w-4" /></button>
              </div>
              {/* Terminals: render each tab as an AuxTerminal kept mounted with
                  visibility toggle, same as the main tabs — switching tabs must
                  not respawn the shell. */}
              <div className="relative min-h-0 flex-1">
                {(bottomTabs || []).map(t => (
                  <div
                    key={t.id}
                    className="absolute inset-0"
                    style={{ visibility: t.id === activeBottom ? "visible" : "hidden", zIndex: t.id === activeBottom ? 1 : 0 }}
                  >
                    <AuxTerminal wsPath={ws.path} active={t.id === activeBottom} />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
