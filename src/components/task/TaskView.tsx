// Task view: TabBar + per-tab content. Optional horizontal split puts a
// scratch shell terminal on the bottom half so the user can run git/grep/etc.
// without leaving the agent up top.
//
// Per-tab content stays mounted across tab switches (we toggle `display`
// instead of unmount) — terminals MUST keep their xterm instances alive.
// display:none (NOT visibility:hidden) is load-bearing: xterm's renderer
// only pauses on zero geometry, so a visibility-hidden terminal still runs
// WebGL draws for every TUI repaint. See MainArea for the full story.
//
// One exception, and only one: a hidden PDF tab keeps its `display` and goes
// to opacity 0 instead (keepsDisplayWhenHidden). WKWebView tears down the
// native PDF view inside a display:none subtree and rebuilds it at page 1,
// and no DOM state survives to restore the reader's place. The perf argument
// above doesn't reach it — a PDF is a static image that never repaints, so a
// painted-but-invisible one costs a composite, not a WebGL draw loop. Do NOT
// widen this to terminals.

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DockerBuildPane } from "@/components/task/DockerBuildPane";
import type { Task, Tab, TerminalTab } from "@/lib/types";
import { useApp, useTaskTabs, useActiveTabId } from "@/store/app";
import { usePrefs, currentTerminalTheme } from "@/store/prefs";
import { TabBar, TabPill } from "./TabBar";
import { TabContextMenu } from "./TabContextMenu";
import { TerminalPane, FooterBar } from "./TerminalPane";
import { RunPane } from "./RunPane";
import { SplitNodeView } from "./SplitView";
import { AuxTerminal } from "./AuxTerminal";
import { MessageQueueButton } from "./MessageQueueButton";
import { Plus, ChevronDown, ChevronUp, ChevronRight, LocateFixed, Copy, Check, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { getAllLeaves, computeLeafBounds, focusedTabId } from "@/lib/splitTree";
import type { PaneLeaf, Rect } from "@/lib/splitTree";
import { openPath, revealPath } from "@/lib/ipc";
import { copyToClipboard } from "@/lib/clipboard";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/ContextMenu";
import { CopyPathItems } from "./CopyPathItems";
import { useUI } from "@/store/ui";
import { MARKDOWN, effectiveLanguageId, languageLabel } from "@/lib/languages";
import { dirnamePosix, MARKDOWN_EXT_RE } from "@/lib/markdownPaths";
import { isSvgPath, keepsDisplayWhenHidden, previewKindForPath } from "@/lib/previewPaths";
import { restoreScratchTabs } from "@/lib/scratchTabs";
import { CodeIntelChip } from "./CodeIntelChip";
const EditorPane = lazy(() => import("./EditorPane").then(m => ({ default: m.EditorPane })));
const DiffPane   = lazy(() => import("./DiffPane").then(m => ({ default: m.DiffPane })));
const MarkdownPane = lazy(() => import("./MarkdownPane").then(m => ({ default: m.MarkdownPane })));
const SvgPane = lazy(() => import("./SvgPane").then(m => ({ default: m.SvgPane })));
const PreviewPane  = lazy(() => import("./PreviewPane").then(m => ({ default: m.PreviewPane })));
const DirListingPane = lazy(() => import("./DirListingPane").then(m => ({ default: m.DirListingPane })));
// Lightweight extension check so we don't import the (lazy) MarkdownPane
// module just to ask whether a path is markdown. Shared with the markdown
// preview's link handler (markdownPaths.ts) so both agree on what counts.
const isMarkdownPath = (p: string) => MARKDOWN_EXT_RE.test(p);

const DEFAULT_SPLIT_HEIGHT = 240;
const MIN_HEIGHT = 80;
const DEFAULT_SPLIT_WIDTH = 360;
const MIN_WIDTH = 120;

// Conductor-style path breadcrumb under the tab bar, shown for the active file
// tab. Each segment is individually clickable: a folder reveals/expands that
// folder in the tree, the filename reveals the file. The locate button on the
// right reveals the file too.
function EditorBreadcrumb({ task }: { task: Task }) {
  const { t } = useTranslation("task");
  const activeId = useActiveTabId(task.id);
  const tab = useApp(s => (s.tabs[task.id] ?? []).find(t => t.id === activeId));
  const revealInTree = useApp(s => s.revealInTree);
  const openSyntaxPalette = useUI(s => s.openSyntaxPalette);
  const [copied, setCopied] = useState(false);
  // A scratchpad has no path, so there is no trail to render and nothing to
  // copy, locate or open in Finder. It DOES get the syntax button: with no
  // extension to go on, the content sniffer's guess (and the user's override)
  // is the only thing that says how the buffer is being highlighted.
  if (tab?.type === "scratch") {
    return (
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate text-[var(--color-fg-faint)]">
          {t("breadcrumb.scratchHint")}
        </span>
        <button
          data-testid="syntax-button"
          onClick={() => openSyntaxPalette(task.id, tab.id)}
          title={t("breadcrumb.setSyntaxTip")}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          {languageLabel(effectiveLanguageId(tab))}
        </button>
      </div>
    );
  }
  // An out-of-task file (GH #240). Its path is ABSOLUTE and points outside the
  // task, so none of the trail below applies: the segments are not task
  // -relative, there is nothing to locate in the file tree, and the file is
  // read-only. It still gets the syntax button, and the full path is rendered
  // rather than a basename because "which file is this, exactly" is the whole
  // question for a path that came out of agent output.
  if (tab?.type === "external") {
    const extName = tab.path.split("/").pop() || tab.path;
    return (
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 text-[12px]">
        <img src={fileIconUrl(extName)} alt="" className="mr-1 h-3.5 w-3.5 shrink-0 file-icon" />
        <span className="min-w-0 flex-1 truncate text-[var(--color-fg-faint)]" title={tab.path}>
          {tab.path}
        </span>
        <span className="shrink-0 rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-faint)]">
          {t("breadcrumb.readOnly")}
        </span>
        <button
          data-testid="syntax-button"
          onClick={() => openSyntaxPalette(task.id, tab.id)}
          title={t("breadcrumb.setSyntaxTip")}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          {languageLabel(effectiveLanguageId(tab))}
        </button>
        <button
          onClick={() => void copyToClipboard(tab.path, "path")}
          title={t("breadcrumb.copyPathTip")}
          className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => revealPath(tab.path).catch(() => {})}
          title={t("breadcrumb.revealInFinderTip")}
          className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  if (!tab || (tab.type !== "edit" && tab.type !== "diff") || !tab.path) return null;
  const path = tab.path;
  const parts = path.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] ?? path;
  const dir = dirnamePosix(path);
  // Absolute folder that contains the file — opening THE DIRECTORY (not the
  // file) launches the OS file manager (Finder / Files / Explorer) at that
  // location. openPath → opener plugin: `open` on macOS, xdg-open on Linux.
  const folderAbs = dir ? `${task.path}/${dir}` : task.path;
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
                    onClick={() => revealInTree(task.id, rel, !isLast)}
                    title={isLast ? t("breadcrumb.locateTip") : t("breadcrumb.revealTip", { rel })}
                    className={cn(
                      "max-w-[240px] truncate rounded px-1 py-0.5 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                      isLast ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]",
                    )}
                  >{seg}</button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <CopyPathItems rel={rel} root={task.path} isDir={!isLast} />
                </ContextMenuContent>
              </ContextMenuRoot>
            </div>
          );
        })}
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        {/* Sublime puts the syntax picker bottom-right; termic has no status
            bar, and inventing one to hold a single control would cost the
            terminal an edge. It goes on the bar this file already has, next
            to the other per-file actions. Editor tabs only: a diff has no
            editable buffer, so its syntax always follows its path. */}
        {/* Code intelligence is armed HERE, next to the language it applies to,
            rather than in Settings: the moment it would help is while reading
            code, not while browsing preferences. Renders nothing at all unless
            the app-wide pref offers it and something can answer for this
            language (GH #174). */}
        {tab.type === "edit" && (
          <CodeIntelChip task={task} registryName={effectiveLanguageId(tab)} path={tab.path} />
        )}
        {tab.type === "edit" && (
          <button
            data-testid="syntax-button"
            onClick={() => openSyntaxPalette(task.id, tab.id)}
            title={t("breadcrumb.setSyntaxTip")}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            {languageLabel(effectiveLanguageId(tab))}
          </button>
        )}
        <button onClick={copyPath} title={t("breadcrumb.copyPathTip")} className={iconBtn}>
          {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-accent)]" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => openPath(folderAbs).catch(() => {})} title={t("breadcrumb.openInFileManagerTip")} className={iconBtn}>
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => revealInTree(task.id, path, false)} title={t("breadcrumb.locateTip")} className={iconBtn}>
          <LocateFixed className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function TaskView({ task }: { task: Task }) {
  const { t } = useTranslation("task");
  const ensureDefaultTab = useApp(s => s.ensureDefaultTab);
  const tabs = useTaskTabs(task.id);
  const activeId = useActiveTabId(task.id);
  const split        = useApp(s => !!s.terminalSplit[task.id]);
  const splitHeight  = useApp(s => s.terminalSplitHeight[task.id] ?? DEFAULT_SPLIT_HEIGHT);
  const setSplitHeight = useApp(s => s.setTerminalSplitHeight);
  const collapsed    = useApp(s => !!s.terminalSplitCollapsed[task.id]);
  const toggleCollapsed = useApp(s => s.toggleTerminalSplitCollapsed);
  const bottomTabs   = useApp(s => s.bottomTabs[task.id]);
  const activeBottom = useApp(s => s.activeBottomTab[task.id]);
  const addBottomTab = useApp(s => s.addBottomTab);
  const closeBottomTab = useApp(s => s.closeBottomTab);
  const setActiveBottom = useApp(s => s.setActiveBottomTab);
  const pinBottomTab = useApp(s => s.pinBottomTab);
  const unpinBottomTab = useApp(s => s.unpinBottomTab);
  const setBottomLiveTitle = useApp(s => s.setBottomTabLiveTitle);

  // Subscribe to themeMode (and the custom-theme edit counter) so the
  // terminals-area bg recomputes when the user switches or edits themes.
  usePrefs(s => s.themeMode);
  usePrefs(s => s.customThemeRev);
  const xtermBg = currentTerminalTheme().background as string;

  // Task split tree: the main pane is an ordinary leaf (isMain flag) that
  // can sit anywhere in the tree — splitting main nests it deeper, like any
  // pane. All geometry comes from computeLeafBounds over the full tree.
  const splitPaneDim       = usePrefs(s => s.splitPaneDim);
  const splitPaneDimAmount = usePrefs(s => s.splitPaneDimAmount);

  // Task-level split tree (for layout of the main pane width and resize handle).
  const splitRoot = useApp(s => {
    const t = s.splitTree[task.id];
    return (t && t.type === 'split') ? t : null;
  });
  const splitActivePaneId = useApp(s => s.activePaneId[task.id] ?? "");
  const setActivePaneId = useApp(s => s.setActivePaneId);
  const setSplitRatio = useApp(s => s.setSplitRatio);

  useEffect(() => { ensureDefaultTab(task.id, task.cli); }, [task.id, task.cli, ensureDefaultTab]);

  // Bring back this task's scratchpads (GH #244). Deliberately NOT part of
  // `persisted_tabs`, which is agent-tabs-only by construction: pads restore
  // from their own index, unfocused and behind whatever agent tab the line
  // above just seeded. Idempotent, so a remount cannot double a tab.
  useEffect(() => { void restoreScratchTabs(task.id); }, [task.id]);

  // Seed the first bottom tab the moment the split opens.
  useEffect(() => {
    if (split && (!bottomTabs || bottomTabs.length === 0)) addBottomTab(task.id, { focus: false });
  }, [split, bottomTabs, task.id, addBottomTab]);

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

  // The one tab in the whole app whose ⌘F should work. Stricter than the
  // `tabActive` below, which is per-task: MainArea keeps every visited task
  // mounted, so a background task's preview would answer yes too. Modals are
  // NOT handled here — the preview's own listener checks the focus trap, which
  // covers every dialog plus the hand-rolled Settings overlay in one place.
  const keyboardTabId = focusedTabId(splitRoot, splitActivePaneId, activeId);
  const taskUpFront = useApp(s => s.activeTaskId === task.id);

  // Chrome heights the content must sit below. When there's no split, the
  // TabBar + breadcrumb render ABOVE hRow, so main content fills hRow whole.
  // With a split they render inside the main wrapper: TabBar h-9 (36px) plus
  // the breadcrumb h-7 (28px) when it's visible — same condition as
  // EditorBreadcrumb's own null-return. Pane headers are always h-9.
  const activeMainTab = tabs.find(t => t.id === activeId);
  const bcVisible = !!activeMainTab && (
    activeMainTab.type === "scratch"
    || activeMainTab.type === "external"
    || ((activeMainTab.type === "edit" || activeMainTab.type === "diff") && !!activeMainTab.path)
  );
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

  // Scratch shells live in a separate `bottomTabs` array, but render through
  // the SAME TabPill as agent tabs (via a synthetic shell Tab) so every strip
  // looks identical.
  const renderBottomPill = (t: NonNullable<typeof bottomTabs>[number]) => (
    <TabContextMenu
      key={t.id}
      tabs={bottomTabs || []}
      tabId={t.id}
      pinned={!!t.pinned}
      onPin={() => pinBottomTab(task.id, t.id)}
      onUnpin={() => unpinBottomTab(task.id, t.id)}
      onClose={() => closeBottomTab(task.id, t.id)}
      // Plain shells: nothing to confirm, nothing to resume.
      onCloseMany={(ids) => ids.forEach(id => closeBottomTab(task.id, id))}
    >
      <TabPill
        task={task}
        tab={{ id: t.id, type: "terminal", cli: "shell", title: t.title, liveTitle: t.liveTitle, pinned: t.pinned } as TerminalTab}
        active={t.id === activeBottom}
        paneFocused
        compact
        onSelect={() => setActiveBottom(task.id, t.id)}
        onClose={() => closeBottomTab(task.id, t.id)}
        onUnpin={() => unpinBottomTab(task.id, t.id)}
        renaming={null}
        onStartRename={() => {}}
        onChangeRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        dragging={false}
        dragTx={0}
        onStartDrag={() => {}}
      />
    </TabContextMenu>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!splitRoot && <TabBar task={task} />}
      {!splitRoot && <EditorBreadcrumb task={task} />}
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
        {/* hRow: main tab-stack always mounted alongside the task-level
            extra-pane container (visibility-toggled when splitRoot is null). */}
        <div className="relative flex min-h-0 flex-1">
          {/* Pre-launch image rebuild takes the pane while the agent waits on
              it, the same way CreatingTaskPane owns the pane of a task that
              is still being made. Renders nothing unless a build is running
              FOR THIS TASK, and clears itself the moment one succeeds, so the
              terminal underneath is untouched the rest of the time. */}
          <DockerBuildPane taskId={task.id} />
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
              if (mainLeafId) setActivePaneId(task.id, mainLeafId);
            }}
          >
            {splitRoot && <TabBar task={task} />}
            {splitRoot && <EditorBreadcrumb task={task} />}
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
                task={task}
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
              // Terminals and editors want the per-task answer above: they use
              // it to focus themselves, and a background task refocusing its
              // own editor is harmless. The preview needs the app-wide one,
              // because it claims a window-level ⌘F with stopPropagation.
              // Necessary but not sufficient: this says nothing about the
              // bottom split or the right panel, which aren't in the tree, so
              // the preview also checks where focus actually is.
              const ownsFind = taskUpFront && t.id === keyboardTabId;
              const attrs = leaf
                ? { "data-split-leaf": "", "data-pane-id": leaf.id, "data-tab-id": t.id }
                : { "data-main-content": "", "data-main-tab-id": t.id };
              // A hidden PDF tab is the one exception to display:none (see
              // file header): opacity 0 keeps its native <embed> in the
              // render tree, and with it the page the user was reading.
              const keepDisplay = !visible && keepsDisplayWhenHidden(t);
              return (
                <div
                  key={t.id}
                  {...attrs}
                  tabIndex={-1}
                  // inert only ever applies to a hidden pane: an invisible
                  // PDF is still a real element, and must take neither focus
                  // nor a stray click.
                  inert={keepDisplay}
                  className="pointer-events-auto absolute overflow-hidden outline-none"
                  // display:none, not visibility:hidden — pauses the hidden
                  // tab's xterm/CodeMirror rendering (see file header).
                  style={{
                    ...style,
                    ...(keepDisplay
                      ? { opacity: 0, pointerEvents: "none" as const }
                      : { display: visible ? undefined : "none" }),
                    zIndex: visible ? 1 : 0,
                  }}
                  onMouseDown={() => {
                    const target = leaf ? leaf.id : mainLeafId;
                    if (target && splitActivePaneId !== target) setActivePaneId(task.id, target);
                  }}
                >
                  {t.type === "terminal" && ((t as TerminalTab).runTab
                    ? <RunPane task={task} tab={t as TerminalTab} active={tabActive} />
                    : <TerminalPane task={task} tab={t as TerminalTab} active={tabActive} />)}
                  {t.type === "edit"     && (
                    <Suspense fallback={null}>
                      {isSvgPath(t.path)
                        ? <SvgPane task={task} tab={t} active={tabActive} />
                        : previewKindForPath(t.path)
                          ? <PreviewPane task={task} tab={t} />
                          : isMarkdownPath(t.path)
                            ? <MarkdownPane task={task} tab={t} visible={visible} ownsFind={ownsFind} active={tabActive} />
                            : <EditorPane task={task} tab={t} active={tabActive} />}
                    </Suspense>
                  )}
                  {t.type === "scratch"  && (
                    <Suspense fallback={null}>
                      {/* A pad whose syntax resolves to markdown gets the same
                          source / preview / split shell a `.md` file does. It
                          is keyed off the SYNTAX rather than a path because a
                          pad has no extension: picking Markdown is how you say
                          "this is a document", and the toggle is most of what
                          that buys you. Swapping panes remounts CodeMirror
                          once, which the pad's unmount flush already covers. */}
                      {effectiveLanguageId(t) === MARKDOWN
                        ? <MarkdownPane task={task} tab={t} visible={visible} ownsFind={ownsFind} active={tabActive} />
                        : <EditorPane task={task} tab={t} active={tabActive} />}
                    </Suspense>
                  )}
                  {t.type === "external" && (
                    <Suspense fallback={null}>
                      {/* Markdown gets the preview shell; everything else is
                          read-only source (GH #240). The SVG / binary shells
                          stay off: they read their bytes through the task-
                          contained IPC, which an out-of-task file cannot pass.
                          The markdown preview resolves its links against the
                          FILE's directory instead of the task root, and does
                          not load relative images (see MarkdownCtx.external). */}
                      {isMarkdownPath(t.path)
                        ? <MarkdownPane task={task} tab={t} visible={visible} ownsFind={ownsFind} active={tabActive} />
                        : <EditorPane task={task} tab={t} active={tabActive} />}
                    </Suspense>
                  )}
                  {t.type === "diff"     && <Suspense fallback={null}><DiffPane task={task} tab={t} /></Suspense>}
                  {t.type === "dir"      && <Suspense fallback={null}><DirListingPane task={task} tab={t} visible={visible} ownsFind={ownsFind} /></Suspense>}
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
                    const cur = useApp.getState().terminalSplitHeight[task.id] ?? DEFAULT_SPLIT_HEIGHT;
                    const next = Math.round(Math.max(MIN_HEIGHT, Math.min(containerH - MIN_HEIGHT, cur - dy)));
                    setSplitHeight(task.id, next);
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
                <MessageQueueButton taskId={task.id} compact className="self-center" />
                <div className="mx-1.5 h-5 w-px shrink-0 self-center bg-[var(--color-border-soft)]" />
                {/* Tabs + New scroll horizontally (no scrollbar) so the queue
                    button on the left and the collapse toggle on the right stay
                    fixed and reachable no matter how many shells are open. */}
                {/* Pinned shells sit outside the scroller so they stay in
                    reach, same as the main strip (issue #183). */}
                {(bottomTabs || []).some(t => t.pinned) && (
                  <>
                    <div data-pinned-strip="" className="flex shrink-0 items-stretch gap-0 overflow-x-auto no-scrollbar max-w-[55%]">
                      {(bottomTabs || []).filter(t => t.pinned).map(renderBottomPill)}
                    </div>
                    <div className="mx-1 h-5 w-px shrink-0 self-center bg-[var(--color-border-soft)]" />
                  </>
                )}
                <div data-scroll-strip="" className="flex min-w-0 flex-1 items-stretch gap-0 overflow-x-auto no-scrollbar">
                  {(bottomTabs || []).filter(t => !t.pinned).map(renderBottomPill)}
                  <button
                    title={t("breadcrumb.newShellTabTip")}
                    onClick={() => addBottomTab(task.id)}
                    className="ml-1 shrink-0 self-center rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                  ><Plus className="h-4 w-4" /></button>
                </div>
                <div className="ml-auto flex items-center gap-0.5">
                  <button
                    title={collapsed ? t("breadcrumb.expandTerminalTip") : t("breadcrumb.collapseTerminalTip")}
                    onClick={() => toggleCollapsed(task.id)}
                    className="rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
                  >
                    {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {/* Terminals: render each tab as an AuxTerminal kept mounted with
                  a display toggle, same as the main tabs — switching tabs must
                  not respawn the shell, and hidden shells must not render. */}
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
                    style={{ display: t.id === activeBottom ? undefined : "none", zIndex: t.id === activeBottom ? 1 : 0 }}
                  >
                    <AuxTerminal
                      taskId={task.id}
                      tabId={t.id}
                      taskPath={task.path}
                      active={t.id === activeBottom}
                      // Grab focus once the PTY is live, but only for shells
                      // the user explicitly created (set by addBottomTab) —
                      // not the auto-seed on split-open / launch.
                      autoFocus={!!t.autoFocus}
                      // closeBottomTab moves focus to the shell that takes
                      // over (or the main pane if this was the last one),
                      // so Ctrl+D'ing through shells never dumps focus.
                      onExited={() => closeBottomTab(task.id, t.id)}
                      onTitle={(title) => setBottomLiveTitle(task.id, t.id, title)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {/* Sandbox status row — hoisted out of TerminalPane so it
            sits BELOW the bottom-split (when open) and stays the
            visual bottom of the task regardless of which tab
            type is active. Always rendered. */}
        <FooterBar task={task} sandboxWarning={null} />
      </div>
    </div>
  );
}
