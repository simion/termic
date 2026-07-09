// Workspace view: TabBar + per-tab content. Optional horizontal split puts a
// scratch shell terminal on the bottom half so the user can run git/grep/etc.
// without leaving the agent up top.
//
// Per-tab content stays mounted across tab switches (we toggle visibility
// instead of unmount) — terminals MUST keep their xterm instances alive.

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Workspace, Tab, TerminalTab } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { usePrefs, currentTerminalTheme } from "@/store/prefs";
import { TabBar, TabPill } from "./TabBar";
import { TerminalPane, FooterBar } from "./TerminalPane";
import { RunPane } from "./RunPane";
import { SplitNodeView } from "./SplitView";
import { AuxTerminal } from "./AuxTerminal";
import { MessageQueueButton } from "./MessageQueueButton";
import { Plus, ChevronDown, ChevronUp, ChevronRight, LocateFixed, Copy, Check, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { getAllLeaves, computeLeafBounds } from "@/lib/splitTree";
import type { PaneLeaf, Rect } from "@/lib/splitTree";
import { openPath } from "@/lib/ipc";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/ContextMenu";
import { CopyPathItems } from "./CopyPathItems";
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
              {/* Each segment is its own copy target: right-clicking a folder
                  segment copies the path up to that folder; the last segment
                  copies the file (GH #44). */}
              <ContextMenuRoot>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => revealInTree(ws.id, rel, !isLast)}
                    title={isLast ? "Locate in file tree" : `Reveal ${rel} in file tree`}
                    className={cn(
                      "max-w-[240px] truncate rounded px-1 py-0.5 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                      isLast ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]",
                    )}
                  >{seg}</button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <CopyPathItems rel={rel} root={ws.path} isDir={!isLast} />
                </ContextMenuContent>
              </ContextMenuRoot>
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

  // Subscribe to themeMode (and the custom-theme edit counter) so the
  // terminals-area bg recomputes when the user switches or edits themes.
  usePrefs(s => s.themeMode);
  usePrefs(s => s.customThemeRev);
  const xtermBg = currentTerminalTheme().background as string;

  // Workspace split tree: the main pane is an ordinary leaf (isMain flag) that
  // can sit anywhere in the tree — splitting main nests it deeper, like any
  // pane. All geometry comes from computeLeafBounds over the full tree.
  const splitPaneDim       = usePrefs(s => s.splitPaneDim);
  const splitPaneDimAmount = usePrefs(s => s.splitPaneDimAmount);

  // Workspace-level split tree (for layout of the main pane width and resize handle).
  const splitRoot = useApp(s => {
    const t = s.splitTree[ws.id];
    return (t && t.type === 'split') ? t : null;
  });
  const splitActivePaneId = useApp(s => s.activePaneId[ws.id] ?? "");
  const setActivePaneId = useApp(s => s.setActivePaneId);
  const setSplitRatio = useApp(s => s.setSplitRatio);

  useEffect(() => { ensureDefaultTab(ws.id, ws.cli); }, [ws.id, ws.cli, ensureDefaultTab]);

  // Seed the first bottom tab the moment the split opens.
  useEffect(() => {
    if (split && (!bottomTabs || bottomTabs.length === 0)) addBottomTab(ws.id, { focus: false });
  }, [split, bottomTabs, ws.id, addBottomTab]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Mask the one-frame "stretched text" artifact that appears when the main
  // pane resizes between split and non-split tabs. A useLayoutEffect fires
  // synchronously before the browser paints, so we can put an opaque overlay
  // (same color as the terminal bg) over the main pane for 2 rAFs — hiding
  // the stretched canvas — then remove it once xterm has re-fitted.
  const [maskingResize, setMaskingResize] = useState(false);
  const prevSplitStatus = useRef(!!splitRoot);
  useLayoutEffect(() => {
    const hadSplits = prevSplitStatus.current;
    const hasSplits = !!splitRoot;
    prevSplitStatus.current = hasSplits;
    if (hadSplits === hasSplits) return;
    setMaskingResize(true);
    let r1 = 0, r2 = 0;
    r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setMaskingResize(false)); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, !!splitRoot]);

  // ── Content-layer geometry ─────────────────────────────────────────────
  // EVERY tab's content (main + split panes) renders in ONE flat layer over
  // hRow, keyed by tab id (see the layer below). Moving a tab between panes
  // (or main ↔ pane) is then just an inline-style change — React never
  // reparents the subtree, so terminals keep their PTY/xterm instance and
  // editors keep their (possibly dirty) buffer. The chrome (tab strips, pane
  // headers, launchers, dim overlays, resize handles) stays where it was.
  const mainLeaf = splitRoot ? getAllLeaves(splitRoot).find(l => l.isMain) : null;
  const mainLeafId = mainLeaf?.id ?? "";
  const isMainActive = !splitRoot || !splitActivePaneId || splitActivePaneId === mainLeafId;
  const mainDimOpacity = (splitPaneDim && splitRoot && !isMainActive) ? splitPaneDimAmount / 100 : 0;
  const mainTabs = tabs.filter(t => !(t as TerminalTab).paneId);

  // Chrome heights the content must sit below. When there's no split, the
  // TabBar + breadcrumb render ABOVE hRow, so main content fills hRow whole.
  // With a split they render inside the main wrapper: TabBar h-9 (36px) plus
  // the breadcrumb h-7 (28px) when it's visible — same condition as
  // EditorBreadcrumb's own null-return. Pane headers are always h-9.
  const activeMainTab = tabs.find(t => t.id === activeId);
  const bcVisible = !!activeMainTab
    && (activeMainTab.type === "edit" || activeMainTab.type === "diff")
    && !!activeMainTab.path;
  const mainTopPx = splitRoot ? 36 + (bcVisible ? 28 : 0) : 0;

  // One computeLeafBounds over the FULL tree positions everything: the main
  // pane is just another leaf, so it can live anywhere in the tree (e.g.
  // "split main below" nests it in a quadrant) — no root-slice special case.
  const fullBounds: Map<string, Rect> | null = splitRoot ? computeLeafBounds(splitRoot) : null;
  const mainRect = fullBounds?.get(mainLeafId) ?? null;

  const paneEntries: { tab: Tab; leaf: PaneLeaf }[] = [];
  if (splitRoot) {
    for (const leaf of getAllLeaves(splitRoot)) {
      if (leaf.isMain) continue;
      for (const id of leaf.tabIds ?? []) {
        const t = tabs.find(tt => tt.id === id);
        if (t) paneEntries.push({ tab: t, leaf });
      }
    }
  }
  // Content rect for a leaf: its tree rect, dropped below its chrome strip
  // (main: TabBar + optional breadcrumb; panes: the h-9 PaneHeader).
  const contentStyle = (leafId: string | null): React.CSSProperties | null => {
    if (!splitRoot || !fullBounds) {
      return leafId === null ? { left: 0, top: 0, width: "100%", height: "100%" } : null;
    }
    const r = fullBounds.get(leafId ?? mainLeafId);
    if (!r) return null;
    const chromePx = leafId === null ? mainTopPx : 36;
    return {
      left:   `${r.x * 100}%`,
      top:    `calc(${r.y * 100}% + ${chromePx}px)`,
      width:  `${r.w * 100}%`,
      height: `calc(${r.h * 100}% - ${chromePx}px)`,
    };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!splitRoot && <TabBar ws={ws} />}
      {!splitRoot && <EditorBreadcrumb ws={ws} />}
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
        {/* hRow: main tab-stack always mounted alongside the workspace-level
            extra-pane container (visibility-toggled when splitRoot is null). */}
        <div className="relative flex min-h-0 flex-1">
          {/* ── Main pane chrome (always alive, never unmounts). Tab CONTENT
               lives in the flat layer below, not here. Positioned at the main
               leaf's rect in the FULL tree, so main can live in any cell
               (e.g. a quadrant after "split main below"). ── */}
          <div
            data-main-content=""
            data-split-leaf=""
            data-pane-id={mainLeafId || "main"}
            className={cn(
              "flex min-h-0 min-w-0 flex-col overflow-hidden",
              splitRoot && mainRect ? "absolute" : "relative",
            )}
            style={splitRoot && mainRect
              ? {
                  left:   `${mainRect.x * 100}%`,
                  top:    `${mainRect.y * 100}%`,
                  width:  `${mainRect.w * 100}%`,
                  height: `${mainRect.h * 100}%`,
                }
              : { flex: 1 }}
            onMouseDown={() => {
              if (mainLeafId) setActivePaneId(ws.id, mainLeafId);
            }}
          >
            {splitRoot && <TabBar ws={ws} />}
            {splitRoot && <EditorBreadcrumb ws={ws} />}
            {mainDimOpacity > 0 && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ backgroundColor: `rgba(128,128,128,${mainDimOpacity})`, zIndex: 10 }}
              />
            )}
            {maskingResize && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ backgroundColor: xtermBg, zIndex: 200 }}
              />
            )}
          </div>

          {/* ── Split pane chrome for the whole tree (headers, launchers,
               dims, ALL resize handles — including the seams around main;
               the main leaf itself is skipped, its chrome is above). The
               container is pointer-events-none so the main chrome underneath
               stays clickable; leaf/handle children opt back in. ── */}
          {splitRoot && (
            <div className="pointer-events-none absolute inset-0">
              <SplitNodeView
                ws={ws}
                node={splitRoot}
                activePaneId={splitActivePaneId}
                xtermBg={xtermBg}
                dimAmount={splitPaneDimAmount}
                dimActive={splitPaneDim && getAllLeaves(splitRoot).length > 1}
              />
            </div>
          )}

          {/* ── Flat content layer: ONE stable parent for every tab's content,
               keyed by tab id, positioned over its pane's content area. A tab
               moving main ↔ pane or pane ↔ pane only changes this div's inline
               style + data attributes — no reparent, no unmount, PTY/xterm and
               editor buffers survive. Dim overlays (z 10) and the resize
               handles (z 20) paint above this layer's z ≤ 1 content; the layer
               itself is pointer-events-none so chrome stays clickable. The
               data attributes keep all DOM-focus-derived logic working: main
               content carries data-main-content + data-main-tab-id, pane
               content carries data-split-leaf + data-pane-id + data-tab-id.
               tabIndex=-1 makes the wrapper the focus fallback for tabs with
               unfocusable content (diff / markdown preview). ── */}
          <div className="pointer-events-none absolute inset-0">
            {[
              ...mainTabs.map(t => ({ t, leaf: null as PaneLeaf | null })),
              ...paneEntries.map(pe => ({ t: pe.tab, leaf: pe.leaf as PaneLeaf | null })),
            ].map(({ t, leaf }) => {
              const style = contentStyle(leaf ? leaf.id : null);
              if (!style) return null;
              const visible = leaf ? t.id === leaf.activeTabId : t.id === activeId;
              const tabActive = leaf
                ? splitActivePaneId === leaf.id && t.id === leaf.activeTabId
                : t.id === activeId;
              const attrs = leaf
                ? { "data-split-leaf": "", "data-pane-id": leaf.id, "data-tab-id": t.id }
                : { "data-main-content": "", "data-main-tab-id": t.id };
              return (
                <div
                  key={t.id}
                  {...attrs}
                  tabIndex={-1}
                  className="pointer-events-auto absolute overflow-hidden outline-none"
                  style={{ ...style, visibility: visible ? "visible" : "hidden", zIndex: visible ? 1 : 0 }}
                  onMouseDown={() => {
                    const target = leaf ? leaf.id : mainLeafId;
                    if (target && splitActivePaneId !== target) setActivePaneId(ws.id, target);
                  }}
                >
                  {t.type === "terminal" && ((t as TerminalTab).runTab
                    ? <RunPane ws={ws} tab={t as TerminalTab} active={tabActive} />
                    : <TerminalPane ws={ws} tab={t as TerminalTab} active={tabActive} />)}
                  {t.type === "edit"     && <Suspense fallback={null}>{isMarkdownPath(t.path) ? <MarkdownPane ws={ws} tab={t} /> : <EditorPane ws={ws} tab={t} active={tabActive} />}</Suspense>}
                  {t.type === "diff"     && <Suspense fallback={null}><DiffPane ws={ws} tab={t} /></Suspense>}
                </div>
              );
            })}
          </div>
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
                <MessageQueueButton wsId={ws.id} compact className="self-center" />
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
                <div className="ml-auto flex items-center gap-0.5">
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
                      wsId={ws.id}
                      wsPath={ws.path}
                      active={t.id === activeBottom}
                      // Grab focus once the PTY is live, but only for shells
                      // the user explicitly created (set by addBottomTab) —
                      // not the auto-seed on split-open / launch.
                      autoFocus={!!t.autoFocus}
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
