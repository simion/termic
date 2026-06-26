// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, Tab, TerminalTab, Agent } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { useTabStripDrag } from "./useTabStripDrag";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL, resolveIconId } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, SquareSplitVertical, SquareSplitHorizontal, TerminalSquare, Bell, Megaphone, Repeat, Loader2 } from "lucide-react";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { requestCloseTab } from "@/lib/closeTab";
import { visibleCliIds, agentDisplayName, isTerminalEntry } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/lib/explorer/iconResolver";

const CLIS = ["claude", "codex", "agy", "grok", "opencode"] as const;

/** Registry entries rendered as dropdown rows — shared by the main strip's
 *  and the right strip's + menus (both their "New terminal" custom entries
 *  and their "New agent" lists) so the two menus can't drift apart. */
function CliMenuItems({ entries, onSpawn }: { entries: Agent[]; onSpawn: (cli: string) => void }) {
  return (
    <>
      {entries.map(a => (
        <DropdownItem key={a.id} onSelect={() => onSpawn(a.id)}>
          <span className={cn("shrink-0", CLI_BRAND_COLOR[a.icon_id] || "text-[var(--color-fg-dim)]")}><CliIcon cli={a.icon_id} className="h-4 w-4" /></span>
          {a.display_name}
        </DropdownItem>
      ))}
    </>
  );
}

/** The plain "Terminal" entry, shared by the main and right-split + menus.
 *  Terminals are ALWAYS uncaged now (only agents run inside the seatbelt —
 *  they're the threat model; a shell the user drives is not). There is no
 *  "Sandboxed" shell variant: a caged terminal you type into yourself made no
 *  sense (it just broke git/ssh + shell history). See issue #32. */
function ShellTerminalItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect}>
      <span className="shrink-0 text-[var(--color-fg-dim)]"><CliIcon cli="shell" className="h-4 w-4" /></span>
      Terminal
    </DropdownItem>
  );
}

export function TabBar({ ws }: { ws: Workspace }) {
  const allTabsRaw = useWorkspaceTabs(ws.id);
  // Main strip shows only non-right-panel tabs.
  const tabs = allTabsRaw.filter(t => t.panel !== "right");
  const activeId = useActiveTabId(ws.id);
  const setActive = useApp(s => s.setActiveTabId);
  const addTab = useApp(s => s.addTab);
  const reorderTab = useApp(s => s.reorderTab);
  const renameTab = useApp(s => s.renameTab);
  // Drag-to-reorder + cross-pane move lives in a shared hook (see
  // useTabStripDrag) so the main and right strips behave identically and any
  // tab type drags the same way. The hook is wired up after the right-split
  // subscriptions below (it needs moveTabToPane).
  const stripRef = useRef<HTMLDivElement>(null);

  // Hide disabled / not-installed agents from the + (new agent) menu.
  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const visibleClis = visibleCliIds(registry.map(a => a.id), registry, detectedClis);
  // Custom terminals (Settings → kind: "terminal", #27) join the "New
  // terminal" section. Disabled toggle only — no PATH detection, their
  // command is a free-form shell line `which` can't probe. Memoized (and
  // passed down to the right strip) — the strip re-renders on every tab
  // state change and the list only depends on the registry.
  const customTerminals = useMemo(
    () => registry.filter(a => isTerminalEntry(a) && !a.disabled),
    [registry],
  );
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
  // Right-panel tabs derived from the unified tab list — terminals AND the
  // edit/diff file tabs opened while the right pane was focused.
  const rightTabs = allTabsRaw.filter(t => t.panel === "right");

  // Shared drag (reorder + cross-pane move) for the main strip.
  const { dragId, dragTx, suppressClickRef, startDrag } = useTabStripDrag({
    wsId: ws.id, pane: "main", stripRef, stripTabs: tabs, allTabs: allTabsRaw, reorderTab, moveTabToPane,
  });

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

  /** Plain login-shell tab. Always uncaged: only agents run inside the
   *  workspace's seatbelt (see ShellTerminalItem / TerminalPane spawn). */
  function spawnShellTab() {
    addAndFocusTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: "Terminal",
      cli: "shell",
    });
  }

  return (
    <div className="termic-tabstrip flex h-9 shrink-0 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      {/* Left portion: scrollable tab pills + a fixed control cluster (new-tab,
          broadcast, split toggles) pinned right. Only the pills scroll.
          items-stretch (NOT items-center) so pills fill the full bar height —
          a centered strip collapses pills to content height, which floats the
          active tab as a boxy pill and drops its border-b-2 mid-bar. The
          right strip already stretches; this keeps both panes identical. */}
      <div className="flex min-w-0 flex-1 items-stretch">
      <div
        ref={stripRef}
        data-main-strip=""
        className={cn(
          "flex min-w-0 flex-1 items-stretch gap-0 pl-2 no-scrollbar",
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
      </div>

      {/* Fixed control cluster — never scrolls; always reachable on the right. */}
      <div className="flex shrink-0 items-center gap-1 pl-1 pr-2">
        <DropdownRoot open={open} onOpenChange={setOpen}>
          <DropdownTrigger asChild>
            <Button size="icon" variant="icon" className="h-8 w-8 shrink-0"><Plus className="h-4 w-4" /></Button>
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
            <ShellTerminalItem onSelect={() => spawnShellTab()} />
            <CliMenuItems entries={customTerminals} onSpawn={spawnTab} />
            <DropdownSeparator />
            <DropdownLabel>New agent</DropdownLabel>
            <CliMenuItems entries={registry.filter(a => visibleClis.has(a.id))} onSpawn={spawnTab} />
          </DropdownMenu>
        </DropdownRoot>

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
          customTerminals={customTerminals}
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
function RightStrip({ ws, rightTabs, allTabsRaw, activeRight, rightFocused, rightSplitRatio, registry, visibleClis, customTerminals,
  setActiveRight, closeRightTab, addRightTab, addRightAgentTab, toggleRightSplit, moveTabToPane, reorderTab }: {
  ws: Workspace;
  rightTabs: Tab[];
  allTabsRaw: Tab[];
  activeRight: string | undefined;
  rightFocused: boolean;
  rightSplitRatio: number;
  registry: Agent[];
  visibleClis: Set<string>;
  customTerminals: Agent[];
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

  // Inline rename state — double-click a non-preview tab to rename, same as
  // the main strip (handled inside the shared TabPill).
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const renameTab = useApp(s => s.renameTab);
  function commitRename() {
    if (!renaming) return;
    renameTab(ws.id, renaming.id, renaming.value);
    setRenaming(null);
  }

  // Shared drag (reorder + cross-pane move) — identical to the main strip via
  // the same hook, so any tab (terminal / edit / diff) drags the same way.
  const stripRef = useRef<HTMLDivElement>(null);
  const { dragId, dragTx, suppressClickRef, startDrag } = useTabStripDrag({
    wsId: ws.id, pane: "right", stripRef, stripTabs: rightTabs, allTabs: allTabsRaw, reorderTab, moveTabToPane,
  });

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
      data-right-strip=""
      className="flex shrink-0 items-stretch overflow-visible border-l-2 border-[var(--color-border-soft)]"
      style={{ width: `${rightSplitRatio * 100}%` }}
    >
      <div
        ref={stripRef}
        className={cn(
          "flex min-w-0 flex-1 items-stretch gap-0 pl-2 no-scrollbar",
          // While dragging, unclip + elevate so the pill stays visible as it
          // crosses into the main pane (see the main strip for the rationale).
          dragId ? "relative z-30 overflow-visible" : "overflow-x-auto overflow-y-hidden",
        )}
      >
        {rightTabs.map(t => (
        <TabPill
          key={t.id} ws={ws} tab={t} active={t.id === activeRight} paneFocused={rightFocused} compact
          onSelect={() => { if (suppressClickRef.current) return; setActiveRight(ws.id, t.id); }}
          onClose={() => closeRightTab(ws.id, t.id)}
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
      </div>

      {/* Fixed controls — new-tab + close-split, never scroll. */}
      <div className="flex shrink-0 items-center pl-1 pr-1">
      <DropdownRoot open={open} onOpenChange={setOpen}>
        <DropdownTrigger asChild>
          <button
            title="New tab in right split"
            className="shrink-0 rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          ><Plus className="h-4 w-4" /></button>
        </DropdownTrigger>
        <DropdownMenu
          align="start"
          onCloseAutoFocus={(e) => {
            if (suppressReturn.current) { suppressReturn.current = false; e.preventDefault(); }
          }}
        >
          <DropdownLabel>New terminal</DropdownLabel>
          <ShellTerminalItem onSelect={spawnRightShell} />
          <CliMenuItems entries={customTerminals} onSpawn={spawnRightAgent} />
          <DropdownSeparator />
          <DropdownLabel>New agent</DropdownLabel>
          <CliMenuItems entries={registry.filter(a => visibleClis.has(a.id))} onSpawn={spawnRightAgent} />
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
        className="shrink-0 rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
      ><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

/** Toggle a vertical split with a scratch shell to the right of the main pane. */
function RightSplitToggle({ wsId }: { wsId: string }) {
  const split = useApp(s => !!s.rightSplit[wsId]);
  const toggleSplit = useApp(s => s.toggleRightSplit);
  return (
    <Tip content={split ? "Close right split" : "Split right (⌘D)"} side="bottom">
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

export function TabPill({ ws, tab, active, paneFocused, compact, onSelect, onClose, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename, dragging, dragTx, onStartDrag }: {
  ws: Workspace; tab: Tab; active: boolean;
  /** True when this pill's pane is the focused one. The active tab keeps its
   *  bg highlight regardless, but only shows the accent underline when its
   *  pane is focused — so across a split only ONE tab reads as fully active. */
  paneFocused: boolean;
  /** Right-split strip: size to content (narrower) instead of the main strip's
   *  fit-three-tabs flex basis. */
  compact?: boolean;
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
      // Active state wins at-a-glance WITHOUT a boxed fill: brighter label
      // (color-fg vs the bar's fg-dim) + medium weight + a bottom-only accent
      // border (border-b-2, set in the className below). No bg fill and no
      // side dividers — both read as a recessed box against the bar.
      // Inactive: fg-dim text, subtle hover overlay — sinks back.
      // Width: basis is one-third of the bar (minus ~5rem reserved for
      // the +/split buttons), flex-grow 0 so tabs DON'T balloon to fill
      // the bar — two tabs stay one-third-width each instead of each
      // eating half the bar. flex-shrink 1 lets a 4th+ tab squeeze the
      // set down toward min-w before the strip scrolls. Net: the bar is
      // always sized to comfortably fit 3 tabs; min-w floors
      // readability, max-w caps a lone tab on a very wide bar.
      style={{
        // Main strip sizes tabs to fit ~three; the right strip sizes to content.
        ...(compact ? null : { flex: "0 1 calc((100% - 5rem) / 3)" }),
        // While dragging this pill rides the cursor via translateX and
        // floats above its neighbours. z-index needs the inline value so
        // it beats sibling stacking contexts. pointer-events: none lets
        // elementFromPoint (cross-pane drop detection) see the pane under
        // the cursor instead of the dragged pill itself.
        ...(dragging ? { transform: `translateX(${dragTx}px)`, zIndex: 30, pointerEvents: "none" as const } : null),
      }}
      // Active cue is a bottom-only accent border (border-b-2), matching the
      // "All files / Git" RTab style — no side dividers, no fill, so the tab
      // never reads as a boxed pill. Focused pane → accent; an unfocused
      // pane's active tab keeps a muted border so only one tab reads as fully
      // active across a split.
      className={cn(
        "group flex h-full self-stretch cursor-pointer items-center gap-1.5 px-3.5 text-[12.5px] transition-colors relative select-none border-b-2",
        compact ? "min-w-[120px] max-w-[220px]" : "min-w-[140px] max-w-[260px]",
        dragging
          ? "cursor-grabbing !transition-none border-transparent bg-[var(--color-bg)] text-[var(--color-fg)] shadow-lg"
          : active
            ? cn("font-medium text-[var(--color-fg)]", paneFocused ? "border-[var(--color-accent)]" : "border-[var(--color-border)]")
            : "border-transparent text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
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
    </div>
  );
}
