// Workspace view: TabBar + per-tab content. Optional horizontal split puts a
// scratch shell terminal on the bottom half so the user can run git/grep/etc.
// without leaving the agent up top.
//
// Per-tab content stays mounted across tab switches (we toggle visibility
// instead of unmount) — terminals MUST keep their xterm instances alive.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Workspace, TerminalTab } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { workDoneCapable } from "@/lib/agents";
import { usePrefs, currentTerminalTheme } from "@/store/prefs";
import { TabBar, TabPill } from "./TabBar";
import { TerminalPane, FooterBar } from "./TerminalPane";
import { AuxTerminal } from "./AuxTerminal";
import { MessageQueueButton } from "./MessageQueueButton";
import { Plus, ChevronDown, ChevronUp, ChevronRight, LocateFixed, Copy, Check, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { openPath } from "@/lib/ipc";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
const EditorPane = lazy(() => import("./EditorPane").then(m => ({ default: m.EditorPane })));
const DiffPane   = lazy(() => import("./DiffPane").then(m => ({ default: m.DiffPane })));
const MarkdownPane = lazy(() => import("./MarkdownPane").then(m => ({ default: m.MarkdownPane })));
// Lightweight extension check so we don't import the (lazy) MarkdownPane
// module just to ask whether a path is markdown.
const isMarkdownPath = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

const DEFAULT_SPLIT_HEIGHT = 240;
const MIN_HEIGHT = 80;
const DEFAULT_SPLIT_WIDTH = 360;
const MIN_WIDTH = 120;

// Conductor-style path breadcrumb under the tab bar, shown for the active file
// tab. Each segment is individually clickable: a folder reveals/expands that
// folder in the tree, the filename reveals the file. The locate button on the
// right reveals the file too.
function EditorBreadcrumb({ ws }: { ws: Workspace }) {
  const activeId = useActiveTabId(ws.id);
  const tab = useApp(s => (s.tabs[ws.id] ?? []).find(t => t.id === activeId));
  const revealInTree = useApp(s => s.revealInTree);
  const [copied, setCopied] = useState(false);
  if (!tab || (tab.type !== "edit" && tab.type !== "diff") || !tab.path) return null;
  const path = tab.path;
  const parts = path.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] ?? path;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  // Absolute folder that contains the file — opening THE DIRECTORY (not the
  // file) launches the OS file manager (Finder / Files / Explorer) at that
  // location. openPath → opener plugin: `open` on macOS, xdg-open on Linux.
  const folderAbs = dir ? `${ws.path}/${dir}` : ws.path;
  const iconBtn = "shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]";
  const copyPath = () => {
    navigator.clipboard.writeText(path)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })
      .catch(() => {});
  };
  return (
    <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 text-[12px]">
      <img src={fileIconUrl(fileName)} alt="" className="mr-1 h-3.5 w-3.5 shrink-0 file-icon" />
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {parts.map((seg, i) => {
          const isLast = i === parts.length - 1;
          const rel = parts.slice(0, i + 1).join("/");
          return (
            <div key={rel} className="flex min-w-0 items-center">
              {i > 0 && <ChevronRight className="mx-0.5 h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />}
              <button
                onClick={() => revealInTree(ws.id, rel, !isLast)}
                title={isLast ? "Locate in file tree" : `Reveal ${rel} in file tree`}
                className={cn(
                  "max-w-[240px] truncate rounded px-1 py-0.5 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                  isLast ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]",
                )}
              >{seg}</button>
            </div>
          );
        })}
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        <button onClick={copyPath} title="Copy path" className={iconBtn}>
          {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-accent)]" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => openPath(folderAbs).catch(() => {})} title="Open in file manager" className={iconBtn}>
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => revealInTree(ws.id, path, false)} title="Locate in file tree" className={iconBtn}>
          <LocateFixed className="h-3.5 w-3.5" />
        </button>
      </div>
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
  const setBottomLiveTitle = useApp(s => s.setBottomTabLiveTitle);

  const rightSplit       = useApp(s => !!s.rightSplit[ws.id]);
  const rightSplitRatio  = useApp(s => s.rightSplitRatio[ws.id] ?? 0.5);
  const setRightRatio    = useApp(s => s.setRightSplitRatio);
  const activeRight      = useApp(s => s.activeRightTab[ws.id]);
  const addRightTab      = useApp(s => s.addRightTab);
  const ensureRightTabs  = useApp(s => s.ensureDefaultRightTabs);

  // Fade the bottom-strip queue button when a right-pane agent is focused —
  // the right footer button (see FooterBar) takes over for that agent.
  const wvActivePane = useApp(s => s.activePane[ws.id] ?? "main");
  const wvAgents = useApp(s => s.agents);
  const wvRightCli = useApp(s => {
    const id = s.activeRightTab[ws.id];
    const t = (s.tabs[ws.id] ?? []).find(x => x.id === id);
    return t && t.type === "terminal" ? t.cli : null;
  });
  const rightHasAgent =
    rightSplit && wvRightCli != null && workDoneCapable(wvRightCli, wvAgents);
  const rightAgentFocused = rightHasAgent && wvActivePane === "right";

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

  // On first open of the right split, either restore persisted agent tabs
  // (ensureDefaultRightTabs) or seed a fresh shell tab. The ensure call
  // is a no-op when right_split_tabs is empty.
  useEffect(() => {
    if (!rightSplit) return;
    ensureRightTabs(ws.id);
    const s = useApp.getState();
    const hasRight = (s.tabs[ws.id] ?? []).some(
      t => t.type === "terminal" && (t as TerminalTab).panel === "right",
    );
    if (!hasRight) addRightTab(ws.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightSplit, ws.id]);

  // Default ratio to 0.5 on first open (no persisted ratio yet).
  useEffect(() => {
    if (!rightSplit) return;
    const stored = useApp.getState().rightSplitRatio[ws.id];
    if (stored == null) setRightRatio(ws.id, 0.5);
  }, [rightSplit, ws.id, setRightRatio]);

  const containerRef = useRef<HTMLDivElement>(null);
  const hRowRef      = useRef<HTMLDivElement>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabBar ws={ws} />
      <EditorBreadcrumb ws={ws} />
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
        {/* Horizontal row: main tab content + optional right split. */}
        <div ref={hRowRef} className="flex min-h-0 flex-1">
          {/* Left: main-panel tab content (agent terminal / editor / diff).
              Right-panel tabs are rendered in the right split below. */}
          <div data-main-content="" className="relative min-h-0 flex-1 min-w-0">
            {tabs.filter(t => t.panel !== "right").map(t => (
              <div
                key={t.id}
                className="absolute inset-0"
                style={{ visibility: t.id === activeId ? "visible" : "hidden", zIndex: t.id === activeId ? 1 : 0 }}
              >
                {t.type === "terminal" && <TerminalPane ws={ws} tab={t} active={t.id === activeId} />}
                {t.type === "edit"     && <Suspense fallback={null}>{isMarkdownPath(t.path) ? <MarkdownPane ws={ws} tab={t} /> : <EditorPane ws={ws} tab={t} />}</Suspense>}
                {t.type === "diff"     && <Suspense fallback={null}><DiffPane   ws={ws} tab={t} /></Suspense>}
              </div>
            ))}
          </div>

          {/* Optional right split: agent or shell tabs to the right of the
              agent. The tab strip lives in TabBar (same row as agent tabs).
              Uses TerminalPane so agents can be placed here with full
              session-resume and attention-tracking support. */}
          {rightSplit && (
            <div
              data-right-split=""
              // 1px border-l (tab-separator color) mirrors the right tab strip
              // in TabBar so the separator is continuous AND crisp — a wider
              // 3px band at this low opacity sat on a sub-pixel boundary and
              // read as fuzzy. With box-sizing: border-box the ResizeHandle's
              // `left-0` resolves inside this border, so `-ml-px` lands the
              // visible 1px handle exactly on it (and aligned with the strip).
              className="relative flex shrink-0 flex-col border-l-2 border-[var(--color-border-soft)]"
              style={{ width: `${rightSplitRatio * 100}%`, backgroundColor: xtermBg }}
            >
              <ResizeHandle
                direction="x"
                className="left-0"
                alwaysVisible
                onDrag={(dx) => {
                  const containerW = hRowRef.current?.clientWidth ?? 800;
                  if (containerW === 0) return;
                  const cur = useApp.getState().rightSplitRatio[ws.id] ?? 0.5;
                  const newRatio = (cur * containerW - dx) / containerW;
                  setRightRatio(ws.id, newRatio);
                }}
              />
              {tabs.filter(t => t.panel === "right").map(t => (
                <div
                  key={t.id}
                  data-tab-id={t.id}
                  className="absolute inset-0"
                  style={{ visibility: t.id === activeRight ? "visible" : "hidden", zIndex: t.id === activeRight ? 1 : 0 }}
                >
                  {t.type === "terminal" && <TerminalPane ws={ws} tab={t} active={t.id === activeRight} />}
                  {t.type === "edit"     && <Suspense fallback={null}>{isMarkdownPath(t.path) ? <MarkdownPane ws={ws} tab={t} /> : <EditorPane ws={ws} tab={t} />}</Suspense>}
                  {t.type === "diff"     && <Suspense fallback={null}><DiffPane   ws={ws} tab={t} /></Suspense>}
                </div>
              ))}
            </div>
          )}
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
              style={{ height: collapsed ? "var(--bottom-bar-h)" : splitHeight }}
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
                // items-stretch (NOT items-center): the TabPills below use
                // h-full + border-b-2, so the strip must give them full height
                // or they collapse to content height and float as boxy pills
                // with the active underline stranded mid-bar. The fixed
                // controls (queue button, separator, collapse toggle) opt back
                // into vertical centering with self-center. Mirrors the main
                // TabBar — see its items-stretch comment for the same rationale.
                "flex h-[var(--bottom-bar-h)] shrink-0 items-stretch gap-0.5 bg-[var(--color-bg-1)] px-2",
                // Always show border-b: separates strip from terminals when expanded,
                // and from FooterBar when collapsed. FooterBar suppresses its own
                // border-t when collapsed to avoid a 2px double line.
                "border-b border-[var(--color-border-soft)]",
              )}>
                {/* Queue affordance pinned far LEFT so it's always seen; the
                    shell tabs start after a separator. The bottom status-bar
                    copy is hidden while the split is open — see FooterBar. */}
                <MessageQueueButton wsId={ws.id} compact className={cn("self-center", rightAgentFocused && "opacity-40 transition-opacity")} />
                <div className="mx-1.5 h-5 w-px shrink-0 self-center bg-[var(--color-border-soft)]" />
                {/* Tabs + New scroll horizontally (no scrollbar) so the queue
                    button on the left and the collapse toggle on the right stay
                    fixed and reachable no matter how many shells are open. */}
                <div className="flex min-w-0 flex-1 items-stretch gap-0 overflow-x-auto no-scrollbar">
                  {(bottomTabs || []).map(t => (
                    // Scratch shells live in a separate `bottomTabs` array, but
                    // render through the SAME TabPill as agent tabs (via a
                    // synthetic shell Tab) so every strip looks identical.
                    <TabPill
                      key={t.id}
                      ws={ws}
                      tab={{ id: t.id, type: "terminal", cli: "shell", title: t.title, liveTitle: t.liveTitle } as TerminalTab}
                      active={t.id === activeBottom}
                      paneFocused
                      compact
                      onSelect={() => setActiveBottom(ws.id, t.id)}
                      onClose={() => closeBottomTab(ws.id, t.id)}
                      renaming={null}
                      onStartRename={() => {}}
                      onChangeRename={() => {}}
                      onCommitRename={() => {}}
                      onCancelRename={() => {}}
                      dragging={false}
                      dragTx={0}
                      onStartDrag={() => {}}
                    />
                  ))}
                  <button
                    title="New shell tab"
                    onClick={() => addBottomTab(ws.id)}
                    className="ml-1 shrink-0 self-center rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                  ><Plus className="h-4 w-4" /></button>
                </div>
                {/* Right group, pushed far right: the right-pane agent's queue
                    button (dimmed unless that pane is focused) sits next to the
                    collapse toggle. */}
                <div className="ml-auto flex items-center gap-0.5">
                  {rightHasAgent && (
                    <MessageQueueButton
                      wsId={ws.id}
                      preferTabId={activeRight}
                      compact
                      className={cn(wvActivePane !== "right" && "opacity-40 transition-opacity")}
                    />
                  )}
                  <button
                    title={collapsed ? "Expand terminal" : "Collapse terminal"}
                    onClick={() => toggleCollapsed(ws.id)}
                    className="rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
                  >
                    {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>
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
                      onTitle={(title) => setBottomLiveTitle(ws.id, t.id, title)}
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
