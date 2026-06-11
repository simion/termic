// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Workspace, Tab, TerminalTab, Agent } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL, resolveIconId } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, SquareSplitVertical, SquareSplitHorizontal, TerminalSquare, Bell, Megaphone, Repeat, Loader2 } from "lucide-react";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { requestCloseTab } from "@/lib/closeTab";
import { visibleCliIds, agentDisplayName } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/lib/explorer/iconResolver";

const CLIS = ["claude", "codex", "agy", "gemini", "grok"] as const;

/** Which split pane sits under a screen point, for cross-pane tab drag.
 *  Panes are tagged with data-attributes: the main strip + content carry
 *  data-main-strip / data-main-content; the right strip + content carry
 *  data-right-strip / data-right-split. Returns null when over neither. */
function paneAtPoint(x: number, y: number): "main" | "right" | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  if (el.closest("[data-right-strip], [data-right-split]")) return "right";
  if (el.closest("[data-main-strip], [data-main-content]")) return "main";
  return null;
}

export function TabBar({ ws }: { ws: Workspace }) {
  const allTabsRaw = useWorkspaceTabs(ws.id);
  // Main strip shows only non-right-panel tabs.
  const tabs = allTabsRaw.filter(t => !(t.type === "terminal" && (t as TerminalTab).panel === "right"));
  const activeId = useActiveTabId(ws.id);
  const setActive = useApp(s => s.setActiveTabId);
  const addTab = useApp(s => s.addTab);
  const reorderTab = useApp(s => s.reorderTab);
  const renameTab = useApp(s => s.renameTab);
  // Drag-to-reorder (issue #6) — pointer-based, NOT HTML5 DnD (WKWebView's
  // native drag is unreliable + Tauri intercepts it for file drops). The
  // dragged pill follows the cursor via a transform; tabs reorder live as
  // its center crosses a neighbour's. `dragId` triggers styling; the live
  // transform lives in `dragTx` (state, so a re-render after a reorder can
  // re-derive it before paint).
  const stripRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTx, setDragTx] = useState(0);
  // Mutable drag bookkeeping that must not trigger re-renders. `appliedTx`
  // is the transform currently on the dragged element — tracked so we can
  // recover its untranslated layout position from a live getBoundingClientRect.
  const dragRef = useRef<{
    id: string; grabOffset: number; startX: number; pointerX: number; pointerY: number; started: boolean; appliedTx: number;
  } | null>(null);
  // Set briefly on drop so the click that ends a drag doesn't also select
  // the tab (pointerup → click both fire).
  const suppressClickRef = useRef(false);

  // Translate that keeps the dragged pill's left edge at (cursor − grab
  // offset). Self-correcting: it reads the pill's live rect and subtracts
  // the transform already applied to recover the untranslated layout slot,
  // so it stays right even after a live reorder shuffles the DOM. Updates
  // `appliedTx` so the next call has the correct baseline.
  function computeTx(clientX: number): number {
    const strip = stripRef.current;
    const d = dragRef.current;
    if (!strip || !d) return 0;
    const pill = strip.querySelector(`[data-tab-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return 0;
    const layoutLeft = pill.getBoundingClientRect().left - d.appliedTx;
    const tx = (clientX - d.grabOffset) - layoutLeft;
    d.appliedTx = tx;
    return tx;
  }

  // Reorder when the dragged pill's center passes a neighbour's center.
  function maybeReorder(clientX: number) {
    const strip = stripRef.current;
    const d = dragRef.current;
    if (!strip || !d) return;
    const pill = strip.querySelector(`[data-tab-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return;
    const draggedCenter = (clientX - d.grabOffset) + pill.offsetWidth / 2;
    const pills = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
    // Target index = how many OTHER pills sit left of the dragged center.
    let target = 0;
    for (const p of pills) {
      if (p.dataset.tabId === d.id) continue;
      const r = p.getBoundingClientRect();
      if (r.left + r.width / 2 < draggedCenter) target++;
    }
    const cur = tabs.findIndex(t => t.id === d.id);
    if (target !== cur) {
      // `tabs` is the filtered (main-panel-only) list; `reorderTab` takes an
      // index into `allTabsRaw` minus the dragged tab. Translate `target` from
      // filtered space to full-array space so right-panel tabs (which sit in
      // the same array but not in the strip) don't corrupt the order.
      const filteredWithout = tabs.filter(t => t.id !== d.id);
      const fullWithout = allTabsRaw.filter(t => t.id !== d.id);
      let fullTarget: number;
      if (target >= filteredWithout.length) {
        const lastMain = filteredWithout[filteredWithout.length - 1];
        fullTarget = lastMain ? fullWithout.findIndex(t => t.id === lastMain.id) + 1 : fullWithout.length;
      } else {
        const anchor = filteredWithout[target];
        fullTarget = fullWithout.findIndex(t => t.id === anchor.id);
      }
      reorderTab(ws.id, d.id, fullTarget);
    }
  }

  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    d.pointerX = e.clientX;
    d.pointerY = e.clientY;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < 5) return; // below the drag threshold
      d.started = true;
      setDragId(d.id);
    }
    setDragTx(computeTx(e.clientX));
    // Only reorder while the cursor is still over the main pane — once it's
    // over the right pane the drop will MOVE the tab, so intra-strip reorder
    // would just thrash the order pointlessly.
    if (paneAtPoint(e.clientX, e.clientY) !== "right") maybeReorder(e.clientX);
  }
  function onPointerUp() {
    const d = dragRef.current;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (d?.started) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      // Dropped over the right pane → move this (main) tab into the split.
      // Only terminal tabs can live in the right pane; edit/diff stay main.
      const dropped = paneAtPoint(d.pointerX, d.pointerY);
      const tab = tabs.find(t => t.id === d.id);
      if (dropped === "right" && tab?.type === "terminal") {
        moveTabToPane(ws.id, d.id, "right");
      }
    }
    dragRef.current = null;
    setDragId(null);
    setDragTx(0);
  }
  function startDrag(tabId: string, e: React.PointerEvent) {
    // Left button only; ignore drags that begin on the close button /
    // rename input (those have their own jobs).
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
    const pill = e.currentTarget as HTMLElement;
    dragRef.current = {
      id: tabId,
      grabOffset: e.clientX - pill.getBoundingClientRect().left,
      startX: e.clientX,
      pointerX: e.clientX,
      pointerY: e.clientY,
      started: false,
      appliedTx: 0,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  // After a live reorder re-renders the strip, the dragged pill sits in a
  // new slot — re-derive its transform from the new layout BEFORE paint so
  // it doesn't jump for a frame.
  useLayoutEffect(() => {
    const d = dragRef.current;
    if (d?.started) setDragTx(computeTx(d.pointerX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // Tear down window listeners if the component unmounts mid-drag.
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Hide disabled / not-installed agents from the + (new agent) menu.
  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const visibleClis = visibleCliIds(registry.map(a => a.id), registry, detectedClis);
  const openBroadcast = useUI(s => s.openBroadcast);
  const [open, setOpen] = useState(false);
  // When spawnTab fires, suppress Radix's auto focus-return so it
  // doesn't yank focus back to the '+' trigger before our terminal-
  // focus call lands.
  const suppressDropdownReturn = useRef(false);
  // Inline rename state: which tab id is being renamed + its draft value.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const rightSplit      = useApp(s => !!s.rightSplit[ws.id]);
  const rightSplitRatio = useApp(s => s.rightSplitRatio[ws.id] ?? 0.5);
  const activeRight     = useApp(s => s.activeRightTab[ws.id]);
  const activePane      = useApp(s => s.activePane[ws.id] ?? "main");
  const moveTabToPane   = useApp(s => s.moveTabToPane);
  // The main strip is the "focused" pane when there's no right split, or
  // when the user last interacted with the main pane. Only the focused
  // pane's active tab shows the full accent-underline cue.
  const mainFocused = !rightSplit || activePane === "main";
  const addRightTab     = useApp(s => s.addRightTab);
  const addRightAgentTab = useApp(s => s.addRightAgentTab);
  const closeRightTab   = useApp(s => s.closeRightTab);
  const setActiveRight  = useApp(s => s.setActiveRightTab);
  const toggleRightSplit = useApp(s => s.toggleRightSplit);
  // Right-panel tabs derived from the unified tab list (already computed above).
  const rightTabs = allTabsRaw.filter(
    t => t.type === "terminal" && (t as TerminalTab).panel === "right",
  ) as TerminalTab[];

  // ⌘T from the main pane (handled in useShortcuts) opens this menu so
  // the user can keyboard-pick an agent / terminal. Scoped by wsId —
  // multiple workspaces stay mounted, so only the targeted TabBar
  // reacts. Radix focuses the first item on open; arrow + Enter from
  // there. Listener identity is stable across renders → mount once.
  useEffect(() => {
    const onMenu = (e: Event) => {
      if ((e as CustomEvent<{ wsId?: string }>).detail?.wsId === ws.id) setOpen(true);
    };
    window.addEventListener("termic-new-tab-menu", onMenu);
    return () => window.removeEventListener("termic-new-tab-menu", onMenu);
  }, [ws.id]);

  function commitRename() {
    if (!renaming) return;
    renameTab(ws.id, renaming.id, renaming.value);
    setRenaming(null);
  }


  // Add a freshly-built terminal tab. `addTab` self-focuses the new
  // terminal (see store) — all we do here is close the dropdown and
  // suppress Radix's focus-return so the closing menu doesn't yank
  // focus back to the '+' trigger before that focus call lands.
  function addAndFocusTab(tab: Tab) {
    suppressDropdownReturn.current = true;
    addTab(ws.id, tab);
    setOpen(false);
  }

  function spawnTab(cli: string) {
    const displayName = agentDisplayName(cli, registry);
    addAndFocusTab({ id: crypto.randomUUID(), type: "terminal", title: displayName, cli });
  }

  /** Plain login-shell tab. `sandboxed` decides whether it spawns
   *  inside the workspace's seatbelt cage — only meaningful (and only
   *  offered) when the workspace has the sandbox enabled. */
  function spawnShellTab(sandboxed: boolean) {
    addAndFocusTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: sandboxed ? "Sandboxed" : "Terminal",
      cli: "shell",
      sandboxed,
    });
  }

  return (
    <div className="termic-tabstrip flex h-9 shrink-0 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      {/* Left portion: agent tabs + utility buttons. flex-1 so it fills all
          space left after the optional right-split strip. overflow-x-auto lets
          many agent tabs scroll horizontally without breaking the layout. */}
      <div
        ref={stripRef}
        data-main-strip=""
        className={cn(
          "flex min-w-0 flex-1 items-center gap-0 pl-2",
          // While dragging, let the pill escape the strip's clip and lift the
          // whole strip above the right strip (a later DOM sibling that would
          // otherwise paint over the pill) so the tab stays visible as it
          // crosses into the other pane.
          dragId ? "relative z-30 overflow-visible" : "overflow-x-auto overflow-y-hidden",
        )}
      >
        {tabs.map(t => (
          <TabPill
            key={t.id} ws={ws} tab={t} active={t.id === activeId} paneFocused={mainFocused}
            onSelect={() => { if (suppressClickRef.current) return; setActive(ws.id, t.id); }}
            onClose={() => requestCloseTab(ws.id, t.id)}
            renaming={renaming?.id === t.id ? renaming.value : null}
            onStartRename={() => setRenaming({ id: t.id, value: t.title })}
            onChangeRename={(v) => setRenaming(r => r ? { ...r, value: v } : r)}
            onCommitRename={commitRename}
            onCancelRename={() => setRenaming(null)}
            dragging={dragId === t.id}
            dragTx={dragId === t.id ? dragTx : 0}
            onStartDrag={(e) => startDrag(t.id, e)}
          />
        ))}

        <DropdownRoot open={open} onOpenChange={setOpen}>
          <DropdownTrigger asChild>
            <Button size="icon" variant="icon" className="ml-1 h-8 w-8 shrink-0"><Plus className="h-4 w-4" /></Button>
          </DropdownTrigger>
          <DropdownMenu
            align="start"
            onCloseAutoFocus={(e) => {
              if (suppressDropdownReturn.current) {
                suppressDropdownReturn.current = false;
                e.preventDefault();
              }
            }}
          >
            <DropdownLabel>New terminal</DropdownLabel>
            <DropdownItem onSelect={() => spawnShellTab(false)}>
              <span className="text-[var(--color-fg-dim)]"><CliIcon cli="shell" className="h-4 w-4" /></span>
              Terminal
            </DropdownItem>
            {ws.sandbox_enabled && (
              <DropdownItem onSelect={() => spawnShellTab(true)}>
                <span className="text-[var(--color-ok)]"><CliIcon cli="shell" className="h-4 w-4" /></span>
                Sandboxed
              </DropdownItem>
            )}
            <DropdownSeparator />
            <DropdownLabel>New agent</DropdownLabel>
            {registry.filter(a => visibleClis.has(a.id)).map(a => (
              <DropdownItem key={a.id} onSelect={() => spawnTab(a.id)}>
                <span className={cn("shrink-0", CLI_BRAND_COLOR[a.icon_id] || "text-[var(--color-fg-dim)]")}><CliIcon cli={a.icon_id} className="h-4 w-4" /></span>
                {a.display_name}
              </DropdownItem>
            ))}
          </DropdownMenu>
        </DropdownRoot>

        <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
          <Tip content="Broadcast a message to all agents from this workspace (⇧⌘B)" side="bottom">
            <Button
              size="icon" variant="icon" className="h-8 w-8"
              onClick={() => openBroadcast(ws.id)}
            >
              <Megaphone className="h-4 w-4" />
            </Button>
          </Tip>

          <SplitToggle wsId={ws.id} />
          <RightSplitToggle wsId={ws.id} />
        </div>
      </div>

      {/* Right portion: agent/shell tabs for the right split. Width matches
          the right panel so the tab strip aligns with the content below. */}
      {rightSplit && (
        <RightStrip
          ws={ws}
          rightTabs={rightTabs}
          allTabsRaw={allTabsRaw}
          activeRight={activeRight}
          rightFocused={activePane === "right"}
          rightSplitRatio={rightSplitRatio}
          registry={registry}
          visibleClis={visibleClis}
          setActiveRight={setActiveRight}
          closeRightTab={closeRightTab}
          addRightTab={addRightTab}
          addRightAgentTab={addRightAgentTab}
          toggleRightSplit={toggleRightSplit}
          moveTabToPane={moveTabToPane}
          reorderTab={reorderTab}
        />
      )}
    </div>
  );
}

/** Tab strip for the right-split panel. Shows agent+shell tabs with the same
 *  "+" dropdown as the main strip so the user can spawn agents in the right
 *  panel too. */
function RightStrip({ ws, rightTabs, allTabsRaw, activeRight, rightFocused, rightSplitRatio, registry, visibleClis,
  setActiveRight, closeRightTab, addRightTab, addRightAgentTab, toggleRightSplit, moveTabToPane, reorderTab }: {
  ws: Workspace;
  rightTabs: TerminalTab[];
  allTabsRaw: Tab[];
  activeRight: string | undefined;
  rightFocused: boolean;
  rightSplitRatio: number;
  registry: Agent[];
  visibleClis: Set<string>;
  setActiveRight: (wsId: string, tabId: string) => void;
  closeRightTab: (wsId: string, tabId: string) => void;
  addRightTab: (wsId: string, sandboxed?: boolean) => string;
  addRightAgentTab: (wsId: string, cli: string) => void;
  toggleRightSplit: (wsId: string) => void;
  moveTabToPane: (wsId: string, tabId: string, toPane: "main" | "right") => void;
  reorderTab: (wsId: string, tabId: string, toIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const suppressReturn = useRef(false);
  const isSandboxed = !!(ws as any).sandbox_enabled;

  // Pointer-drag for right-pane tabs: reorder within the strip, or drop over
  // the main pane to MOVE the session there (mirrors the main strip's drag).
  const stripRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTx, setDragTx] = useState(0);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    id: string; grabOffset: number; startX: number; pointerX: number; pointerY: number; started: boolean; appliedTx: number;
  } | null>(null);

  function computeTx(clientX: number): number {
    const strip = stripRef.current; const d = dragRef.current;
    if (!strip || !d) return 0;
    const pill = strip.querySelector(`[data-tab-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return 0;
    const layoutLeft = pill.getBoundingClientRect().left - d.appliedTx;
    const tx = (clientX - d.grabOffset) - layoutLeft;
    d.appliedTx = tx;
    return tx;
  }
  function maybeReorder(clientX: number) {
    const strip = stripRef.current; const d = dragRef.current;
    if (!strip || !d) return;
    const pill = strip.querySelector(`[data-tab-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return;
    const draggedCenter = (clientX - d.grabOffset) + pill.offsetWidth / 2;
    const pills = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
    let target = 0;
    for (const p of pills) {
      if (p.dataset.tabId === d.id) continue;
      const r = p.getBoundingClientRect();
      if (r.left + r.width / 2 < draggedCenter) target++;
    }
    const cur = rightTabs.findIndex(t => t.id === d.id);
    if (target === cur) return;
    // Translate the filtered (right-only) target into a full-array index for
    // reorderTab, anchoring on the right tab that should follow the dragged one.
    const filteredWithout = rightTabs.filter(t => t.id !== d.id);
    const fullWithout = allTabsRaw.filter(t => t.id !== d.id);
    let fullTarget: number;
    if (target >= filteredWithout.length) {
      const lastRight = filteredWithout[filteredWithout.length - 1];
      fullTarget = lastRight ? fullWithout.findIndex(t => t.id === lastRight.id) + 1 : fullWithout.length;
    } else {
      const anchor = filteredWithout[target];
      fullTarget = fullWithout.findIndex(t => t.id === anchor.id);
    }
    reorderTab(ws.id, d.id, fullTarget);
  }
  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current; if (!d) return;
    d.pointerX = e.clientX; d.pointerY = e.clientY;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < 5) return;
      d.started = true; setDragId(d.id);
    }
    setDragTx(computeTx(e.clientX));
    if (paneAtPoint(e.clientX, e.clientY) !== "main") maybeReorder(e.clientX);
  }
  function onPointerUp() {
    const d = dragRef.current;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (d?.started) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      // Dropped over the main pane → move this session out of the split.
      // moveTabToPane closes the split if this was the last right tab.
      if (paneAtPoint(d.pointerX, d.pointerY) === "main") {
        moveTabToPane(ws.id, d.id, "main");
      }
    }
    dragRef.current = null; setDragId(null); setDragTx(0);
  }
  function startDrag(tabId: string, e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
    const pill = e.currentTarget as HTMLElement;
    dragRef.current = {
      id: tabId,
      grabOffset: e.clientX - pill.getBoundingClientRect().left,
      startX: e.clientX, pointerX: e.clientX, pointerY: e.clientY,
      started: false, appliedTx: 0,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
  useLayoutEffect(() => {
    const d = dragRef.current;
    if (d?.started) setDragTx(computeTx(d.pointerX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightTabs]);
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onMenu = (e: Event) => {
      if ((e as CustomEvent<{ wsId?: string }>).detail?.wsId === ws.id) setOpen(true);
    };
    window.addEventListener("termic-new-right-tab-menu", onMenu);
    return () => window.removeEventListener("termic-new-right-tab-menu", onMenu);
  }, [ws.id]);

  function spawnRightAgent(cli: string) {
    suppressReturn.current = true;
    addRightAgentTab(ws.id, cli);
    setOpen(false);
  }
  function spawnRightShell() {
    suppressReturn.current = true;
    addRightTab(ws.id);
    setOpen(false);
  }

  return (
    <div
      ref={stripRef}
      data-right-strip=""
      className={cn(
        "flex shrink-0 items-stretch gap-0 border-l-2 border-[var(--color-border-soft)] pl-2",
        // While dragging, unclip + elevate so the pill stays visible as it
        // crosses into the main pane (see the main strip for the rationale).
        dragId ? "relative z-30 overflow-visible" : "overflow-x-auto overflow-y-hidden",
      )}
      style={{ width: `${rightSplitRatio * 100}%` }}
    >
      {rightTabs.map(t => {
        const isAgent = t.cli !== "shell";
        const isActive = t.id === activeRight;
        const isDragging = dragId === t.id;
        return (
          // Mirrors the main TabPill design (full-height browser tab,
          // bg-base when active + 2.5px accent underline + border-r
          // separators) so both split panes share one active-tab look.
          <div
            key={t.id}
            data-tab-id={t.id}
            onPointerDown={(e) => startDrag(t.id, e)}
            onClick={() => { if (suppressClickRef.current) return; setActiveRight(ws.id, t.id); }}
            style={isDragging ? { transform: `translateX(${dragTx}px)`, zIndex: 30, pointerEvents: "none" as const } : undefined}
            className={cn(
              "group relative flex h-full cursor-pointer select-none items-center gap-1.5 border-r border-[var(--color-border-soft)] px-3.5 text-[12.5px] transition-colors min-w-[120px] max-w-[220px]",
              isDragging && "!transition-none cursor-grabbing shadow-lg",
              isActive
                ? "bg-[var(--color-bg)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            {isAgent
              ? <CliIcon cli={resolveIconId(t.cli, registry)} className={cn("h-4 w-4 shrink-0", CLI_BRAND_COLOR[resolveIconId(t.cli, registry)] || "text-[var(--color-fg-dim)]")} />
              : <TerminalSquare className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />}
            <span className="min-w-0 flex-1 truncate">{t.liveTitle && !t.customTitle ? t.liveTitle : t.title}</span>
            <button
              title="Close tab"
              className="shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 transition-opacity hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); closeRightTab(ws.id, t.id); }}
            ><X className="h-3 w-3" /></button>
            {isActive && (
              <span className={cn(
                "absolute inset-x-0 bottom-0 h-[2.5px]",
                rightFocused ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]",
              )} />
            )}
          </div>
        );
      })}

      <DropdownRoot open={open} onOpenChange={setOpen}>
        <DropdownTrigger asChild>
          <button
            title="New tab in right split"
            className="ml-1 shrink-0 rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          ><Plus className="h-4 w-4" /></button>
        </DropdownTrigger>
        <DropdownMenu
          align="start"
          onCloseAutoFocus={(e) => {
            if (suppressReturn.current) { suppressReturn.current = false; e.preventDefault(); }
          }}
        >
          <DropdownLabel>New terminal</DropdownLabel>
          <DropdownItem onSelect={spawnRightShell}>
            <span className="text-[var(--color-fg-dim)]"><CliIcon cli="shell" className="h-4 w-4" /></span>
            Terminal
          </DropdownItem>
          {isSandboxed && (
            <DropdownItem onSelect={() => { suppressReturn.current = true; addRightTab(ws.id, true); setOpen(false); }}>
              <span className="text-[var(--color-ok)]"><CliIcon cli="shell" className="h-4 w-4" /></span>
              Sandboxed
            </DropdownItem>
          )}
          <DropdownSeparator />
          <DropdownLabel>New agent</DropdownLabel>
          {registry.filter(a => visibleClis.has(a.id)).map(a => (
            <DropdownItem key={a.id} onSelect={() => spawnRightAgent(a.id)}>
              <span className={cn("shrink-0", CLI_BRAND_COLOR[a.icon_id] || "text-[var(--color-fg-dim)]")}><CliIcon cli={a.icon_id} className="h-4 w-4" /></span>
              {a.display_name}
            </DropdownItem>
          ))}
        </DropdownMenu>
      </DropdownRoot>

      <button
        title="Close right split"
        onClick={() => {
          if (rightTabs.length > 0) {
            const s = useApp.getState();
            for (const t of [...rightTabs]) s.closeRightTab(ws.id, t.id);
          } else {
            toggleRightSplit(ws.id);
          }
        }}
        className="ml-auto shrink-0 rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
      ><X className="h-4 w-4" /></button>
    </div>
  );
}

/** Toggle a vertical split with a scratch shell to the right of the main pane. */
function RightSplitToggle({ wsId }: { wsId: string }) {
  const split = useApp(s => !!s.rightSplit[wsId]);
  const toggleSplit = useApp(s => s.toggleRightSplit);
  return (
    <Tip content={split ? "Close right split" : "Split: open shell right (⌘D)"} side="bottom">
      <Button
        size="icon" variant="icon" className="h-8 w-8"
        onClick={() => toggleSplit(wsId)}
      >
        <SquareSplitHorizontal className={cn("h-4 w-4", split && "text-[var(--color-accent)]")} />
      </Button>
    </Tip>
  );
}

/** Toggle a horizontal split with a scratch shell on the bottom half of the
 *  main pane. State is per-workspace (so each workspace remembers its own
 *  split preference) and persists via the app store. */
function SplitToggle({ wsId }: { wsId: string }) {
  const split = useApp(s => !!s.terminalSplit[wsId]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);
  return (
    <Tip content={split ? "Close split terminal" : "Split: open shell below (⇧⌘D)"} side="bottom">
      <Button
        size="icon" variant="icon" className="h-8 w-8"
        onClick={() => toggleSplit(wsId)}
      >
        <SquareSplitVertical className={cn("h-4 w-4", split && "text-[var(--color-accent)]")} />
      </Button>
    </Tip>
  );
}

function TabPill({ ws, tab, active, paneFocused, onSelect, onClose, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename, dragging, dragTx, onStartDrag }: {
  ws: Workspace; tab: Tab; active: boolean;
  /** True when the main pane is the focused one. The active tab keeps its
   *  bg highlight regardless, but only shows the accent underline when its
   *  pane is focused — so across a split only ONE tab reads as fully active. */
  paneFocused: boolean;
  onSelect: () => void; onClose: () => void;
  renaming: string | null;  // current draft value while renaming, else null
  onStartRename: () => void;
  onChangeRename: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  // Drag-to-reorder wiring (issue #6) — pointer-based.
  dragging: boolean;        // this pill is the one being dragged
  dragTx: number;           // live translateX (px) while dragging, else 0
  onStartDrag: (e: React.PointerEvent) => void;
}) {
  const isUnread = !!tab.unread;
  // iTerm2-parity status indicator on the tab.
  //   attention (orange bell) → agent explicitly blocked on user.
  //   done      (blue bullet) → agent finished a turn; clears on input.
  // Priority: attention > done > brand icon. ("working" spinner +
  // progress bar removed — too many false positives in real-world TUIs.)
  const reason = tab.unread?.reason;
  const workState = tab.type === "terminal" ? tab.workState : undefined;
  const queueRunning = tab.type === "terminal" && !!tab.queueActive;
  const agents = useApp(s => s.agents);
  // Experimental work-in-progress spinner — opt-in (Settings → General).
  // The "working" state is force-cleared by TerminalPane's demoters /
  // absolute ceiling, so the spinner can't spin forever.
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const showBell    = reason === "attention";
  const showDone    = !showBell && workState === "done";
  const showWorking = workingIndicator && !showBell && !showDone && workState === "working";
  const iconId = tab.type === "terminal" ? resolveIconId(tab.cli, agents) : "";
  const color = tab.type === "terminal" ? CLI_BRAND_COLOR[iconId] : "text-[var(--color-fg-dim)]";
  const isRenaming = renaming !== null;

  let fileIcon: string | null = null;
  if ((tab.type === "edit" || tab.type === "diff") && (tab as any).path) {
    const path = (tab as any).path;
    const name = path.split("/").pop() || tab.title;
    fileIcon = fileIconUrl(name);
  }

  return (
    <div
      data-tab-id={tab.id}
      // Start a pointer-drag for reordering, except while renaming (so the
      // inline input handles text selection / caret normally).
      onPointerDown={(e) => { if (!isRenaming) onStartDrag(e); }}
      onClick={() => { if (!isRenaming) onSelect(); }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (tab.preview) {
          useApp.getState().persistTab(ws.id, tab.id);
        } else {
          onStartRename();
        }
      }}
      // Active state needs to win at-a-glance. Three signals stacked:
      //   1. Brighter bg (color-bg-3 vs the bar's color-bg-1).
      //   2. Accent-colored border (vs near-invisible border-soft).
      //   3. Semibold weight on the label.
      // Inactive: muted bg-1 hover, fg-dim text, no border — sinks back.
      // Width: basis is one-third of the bar (minus ~5rem reserved for
      // the +/split buttons), flex-grow 0 so tabs DON'T balloon to fill
      // the bar — two tabs stay one-third-width each instead of each
      // eating half the bar. flex-shrink 1 lets a 4th+ tab squeeze the
      // set down toward min-w before the strip scrolls. Net: the bar is
      // always sized to comfortably fit 3 tabs; min-w floors
      // readability, max-w caps a lone tab on a very wide bar.
      style={{
        flex: "0 1 calc((100% - 5rem) / 3)",
        // While dragging this pill rides the cursor via translateX and
        // floats above its neighbours. z-index needs the inline value so
        // it beats sibling stacking contexts. pointer-events: none lets
        // elementFromPoint (cross-pane drop detection) see the pane under
        // the cursor instead of the dragged pill itself.
        ...(dragging ? { transform: `translateX(${dragTx}px)`, zIndex: 30, pointerEvents: "none" as const } : null),
      }}
      className={cn(
        "group flex h-full self-stretch cursor-pointer items-center gap-1.5 px-3.5 text-[12.5px] transition-colors relative select-none border-r border-[var(--color-border-soft)]",
        "min-w-[140px] max-w-[260px]",
        dragging
          ? "cursor-grabbing !transition-none bg-[var(--color-bg)] text-[var(--color-fg)] shadow-lg"
          : active
            ? "bg-[var(--color-bg)] text-[var(--color-fg)]"
            : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      {/* Work-state badge moved to the trailing slot — see below. */}
      {/* Icon slot: Terminals get CLI brand icons, Edit/Diff tabs get dynamic Catppuccin file icons if path is available, else fallback / none */}
      {(tab.type === "terminal" || fileIcon || tab.type === "diff") && (
        <span className={cn("shrink-0 flex items-center justify-center", color)}>
          {tab.type === "terminal" && <CliIcon cli={iconId} className="h-4 w-4" />}
          {tab.type === "edit" && fileIcon && <img src={fileIcon} alt="" className="h-4 w-4 shrink-0 file-icon" />}
          {tab.type === "diff" && (fileIcon ? <img src={fileIcon} alt="" className="h-4 w-4 shrink-0 file-icon" /> : <GitCompare className="h-4 w-4" />)}
        </span>
      )}
      {/* Running message queue (ralph loop) — subtle accent marker. */}
      {queueRunning && (
        <Repeat className="h-3 w-3 shrink-0 text-[var(--color-accent)]" aria-label="Message queue running" />
      )}
      {isRenaming ? (
        <input
          autoFocus
          value={renaming!}
          // `size` is the input width in characters — clamping to [4, 28] keeps
          // it from collapsing to nothing or eating the whole tab bar.
          size={Math.min(28, Math.max(4, renaming!.length + 1))}
          onChange={e => onChangeRename(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onCommitRename(); }
            else if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
            e.stopPropagation();
          }}
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className="w-auto min-w-0 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1 text-[12.5px] text-[var(--color-fg)] outline-none"
        />
      ) : (
        // Manual rename wins (customTitle locked at rename time).
        // Otherwise show the live OSC 0/2 title the agent set, falling
        // back to the static cli/type label when none arrived yet.
        // min-w-0 + flex-1 so `truncate` actually clips inside the
        // flex pill — without min-w-0 the span keeps its intrinsic
        // width and pushes the pill larger, defeating the fixed-cell
        // layout. Title attr surfaces the full text on hover.
        <span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")} title={tab.liveTitle && !tab.customTitle ? tab.liveTitle : undefined}>
          {tab.customTitle ? tab.title : (tab.liveTitle || tab.title)}
        </span>
      )}
      {/* Trailing slot — iTerm2 convention: status badge / dirty dot
          by default; close × on hover. Fixed cell so the pill never
          jiggles. Priority: attention > done > dirty > none. */}
      {!isRenaming && (
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {(showBell || showDone || showWorking) ? (
            <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0">
              {showBell && (
                <span className="text-[var(--color-warn)]" title="Agent needs your input">
                  <Bell className="h-3.5 w-3.5" strokeWidth={2.5} />
                </span>
              )}
              {showDone && (
                <span title="Agent finished a turn" aria-label="Work done">
                  <span
                    className="block h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--color-info, #4aa3ff)" }}
                  />
                </span>
              )}
              {showWorking && (
                <span className="text-[var(--color-fg-faint)]" title="Agent working" aria-label="Working">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                </span>
              )}
            </span>
          ) : tab.dirty && (
            <span
              aria-hidden
              title="Unsaved changes"
              className="absolute h-[7px] w-[7px] rounded-full bg-[var(--color-fg-dim)] transition-opacity group-hover:opacity-0"
            />
          )}
          <button
            title="Close tab"
            className={cn(
              "absolute inset-0 flex items-center justify-center rounded p-0.5 text-[var(--color-fg-faint)] transition-opacity hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
              (!active || tab.dirty || showBell || showDone || showWorking) && "opacity-0 group-hover:opacity-100",
            )}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          ><X className="h-3 w-3" /></button>
        </span>
      )}
      {active && (
        <span className={cn(
          "absolute inset-x-0 bottom-0 h-[2.5px]",
          // Focused pane → accent underline. Unfocused pane's active tab keeps
          // the bg highlight but a muted underline, so only one tab reads as
          // fully active across a split.
          paneFocused ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]",
        )} />
      )}
    </div>
  );
}
