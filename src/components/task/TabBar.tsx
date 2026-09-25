// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, Tab, TerminalTab } from "@/lib/types";
import { useApp, useTaskTabs, useActiveTabId } from "@/store/app";
import { getAllLeaves } from "@/lib/splitTree";
import { useTabStripDrag } from "./useTabStripDrag";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu } from "@/components/ui/Dropdown";
import { NewTabMenuItems } from "./NewTabMenuItems";
import { newScratchTab } from "@/lib/scratchTabs";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL, resolveIconId } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, SquareSplitVertical, SquareSplitHorizontal, TerminalSquare, Bell, Megaphone, Pin, Repeat, RotateCw, Square, Play, AlertTriangle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { ptyKill } from "@/lib/ipc";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { requestCloseTab, requestCloseTabs } from "@/lib/closeTab";
import { TabContextMenu } from "./TabContextMenu";
import { focusMainTab } from "@/lib/tabFocus";
import { visibleCliIds, agentDisplayName, isTerminalEntry } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { delegatedTitle } from "@/lib/delegatedWork";
import { BackgroundRing } from "@/components/ui/BackgroundRing";
import { formatTerminalTitle } from "@/lib/terminalTitle";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";

const CLIS = ["claude", "codex", "agy", "grok", "opencode"] as const;

export function TabBar({ task }: { task: Task }) {
  const { t } = useTranslation("task");
  const allTabsRaw = useTaskTabs(task.id);
  // Main strip shows only non-pane tabs (split-pane tabs live in SplitView).
  const tabs = allTabsRaw.filter(t => !(t as import("@/lib/types").TerminalTab).paneId);
  const activeId = useActiveTabId(task.id);
  const setActive = useApp(s => s.setActiveTabId);
  const addTab = useApp(s => s.addTab);
  const reorderTab = useApp(s => s.reorderTab);
  const renameTab = useApp(s => s.renameTab);
  const pinTab = useApp(s => s.pinTab);
  const unpinTab = useApp(s => s.unpinTab);
  const stripRef = useRef<HTMLDivElement>(null);

  // The + menu's own rows live in NewTabMenuItems (shared with the sidebar
  // task menu, GH #197); the registry is still needed here for tab titles.
  const registry = useApp(s => s.agents);
  const openBroadcast = useUI(s => s.openBroadcast);
  const resumeClosedTab = useApp(s => s.resumeClosedTab);
  const setView = useApp(s => s.setView);
  const [open, setOpen] = useState(false);
  const suppressDropdownReturn = useRef(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  // Main strip shows the accent underline on the active tab when the main
  // pane is focused (or there are no splits). When a secondary pane is
  // focused, the active tab dims to border-border so only one thing reads
  // as "current" across the whole layout.
  const hasSplitTree = useApp(s => !!s.splitTree[task.id]);
  const activePaneId = useApp(s => s.activePaneId[task.id] ?? "");
  const mainPaneId = useApp(s => {
    const t = s.splitTree[task.id];
    if (!t) return "";
    return getAllLeaves(t).find(l => l.isMain)?.id ?? "";
  });
  const mainFocused = !hasSplitTree || !activePaneId || activePaneId === mainPaneId;

  const moveTabToPane = useApp(s => s.moveTabToPane);
  const moveTabToSplit = useApp(s => s.moveTabToSplit);
  // Move to Split only makes sense once another pane already exists to move
  // into or split off of; a bare main strip has nothing to offer.
  const paneCount = useApp(s => {
    const t = s.splitTree[task.id];
    return t ? getAllLeaves(t).length : 1;
  });

  const { dragId, dragTx, suppressClickRef, startDrag, startMenuMove } = useTabStripDrag({
    taskId: task.id, stripRef, stripTabs: tabs, allTabs: allTabsRaw, reorderTab,
    currentPaneId: null,
    onDropToPane: (tabId, toPaneId) => moveTabToPane(task.id, tabId, toPaneId),
    onDropToSplit: (tabId, toPaneId, zone) => useApp.getState().moveTabToSplit(task.id, tabId, toPaneId, zone),
  });

  // ⌘T from the main pane (handled in useShortcuts) opens this menu so
  // the user can keyboard-pick an agent / terminal. Scoped by taskId —
  // multiple tasks stay mounted, so only the targeted TabBar
  // reacts. Radix focuses the first item on open; arrow + Enter from
  // there. Listener identity is stable across renders → mount once.
  useEffect(() => {
    const onMenu = (e: Event) => {
      if ((e as CustomEvent<{ taskId?: string }>).detail?.taskId === task.id) setOpen(true);
    };
    window.addEventListener("termic-new-tab-menu", onMenu);
    return () => window.removeEventListener("termic-new-tab-menu", onMenu);
  }, [task.id]);

  function commitRename() {
    if (!renaming) return;
    renameTab(task.id, renaming.id, renaming.value);
    setRenaming(null);
  }


  // Add a freshly-built terminal tab. `addTab` self-focuses the new
  // terminal (see store) — all we do here is close the dropdown and
  // suppress Radix's focus-return so the closing menu doesn't yank
  // focus back to the '+' trigger before that focus call lands.
  function addAndFocusTab(tab: Tab) {
    suppressDropdownReturn.current = true;
    addTab(task.id, tab);
    setOpen(false);
  }

  function spawnTab(cli: string) {
    const displayName = agentDisplayName(cli, registry);
    addAndFocusTab({ id: crypto.randomUUID(), type: "terminal", title: displayName, cli });
  }

  // Reopen a closed tab with its original session id (see resumeClosedTab
  // in the store) — same dropdown-close/focus dance as addAndFocusTab,
  // just driven by the store action instead of a locally-built tab.
  function resumeAndFocus(entryId: string) {
    suppressDropdownReturn.current = true;
    resumeClosedTab(task.id, entryId);
    setOpen(false);
  }

  /** Plain login-shell tab. Always uncaged: only agents run inside the
   *  task's seatbelt (see ShellTerminalItem / TerminalPane spawn). */
  function spawnShellTab() {
    addAndFocusTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: "Terminal",
      cli: "shell",
    });
  }

  // The store keeps pinned tabs at the head of the strip, so splitting here
  // preserves the display order (and therefore the DOM order the drag code
  // reads back out of `stripRef`).
  const pinnedTabs = tabs.filter(t => t.pinned);
  const looseTabs = tabs.filter(t => !t.pinned);

  const renderPill = (t: Tab) => (
    <TabContextMenu
      key={t.id} tabs={tabs} tabId={t.id} pinned={!!t.pinned}
      onPin={() => pinTab(task.id, t.id)}
      onUnpin={() => unpinTab(task.id, t.id)}
      onClose={() => requestCloseTab(task.id, t.id)}
      onCloseMany={(ids) => requestCloseTabs(task.id, ids)}
      onSplitRight={() => moveTabToSplit(task.id, t.id, null, 'right')}
      onSplitDown={() => moveTabToSplit(task.id, t.id, null, 'bottom')}
      canSplitOut={tabs.length > 1}
      onMoveToSplit={paneCount > 1 && tabs.length > 1 ? () => startMenuMove(t.id) : undefined}
    >
      <TabPill
        task={task} tab={t} active={t.id === activeId} paneFocused={mainFocused}
        // focusMainTab: keyboard focus must follow the click into the tab's
        // content (terminal / editor) — otherwise the previously focused
        // pane keeps DOM focus and ⌘W acts on the wrong pane.
        onSelect={() => { if (suppressClickRef.current) return; setActive(task.id, t.id); focusMainTab(t.id); }}
        onClose={() => requestCloseTab(task.id, t.id)}
        onUnpin={() => unpinTab(task.id, t.id)}
        renaming={renaming?.id === t.id ? renaming.value : null}
        onStartRename={() => setRenaming({ id: t.id, value: t.title })}
        onChangeRename={(v) => setRenaming(r => r ? { ...r, value: v } : r)}
        onCommitRename={commitRename}
        onCancelRename={() => setRenaming(null)}
        dragging={dragId === t.id}
        dragTx={dragId === t.id ? dragTx : 0}
        onStartDrag={(e) => startDrag(t.id, e)}
      />
    </TabContextMenu>
  );

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
          "flex min-w-0 flex-1 items-stretch gap-0 pl-2",
          // While dragging, lift the whole strip above the right strip (a later
          // DOM sibling that would otherwise paint over the pill) so the tab
          // stays visible as it crosses into the other pane.
          dragId && "relative z-30",
        )}
      >
        {/* Pinned region — OUTSIDE the scroller, which is the whole point of
            pinning (issue #183): a pinned tab must stay in reach no matter how
            far the rest of the strip is scrolled. Capped so that many pinned
            tabs cannot eat the bar and strand the "+" button; past the cap this
            region scrolls on its own. */}
        {pinnedTabs.length > 0 && (
          <>
            <div
              data-pinned-strip=""
              className={cn(
                "flex shrink-0 items-stretch no-scrollbar max-w-[55%]",
                dragId ? "overflow-visible" : "overflow-x-auto",
              )}
            >
              {pinnedTabs.map(renderPill)}
            </div>
            <div className="mx-1 h-5 w-px shrink-0 self-center bg-[var(--color-border-soft)]" />
          </>
        )}

        <div
          data-scroll-strip=""
          className={cn(
            "flex min-w-0 flex-1 items-stretch gap-0 no-scrollbar",
            // The dragged pill escapes this clip so it stays visible while it
            // crosses into the other pane.
            dragId ? "overflow-visible" : "overflow-x-auto overflow-y-hidden",
          )}
        >
        {looseTabs.map(renderPill)}

        {/* New tab button — right after the last tab. When scrolling lands,
            move this back to the sticky right cluster. */}
        <DropdownRoot open={open} onOpenChange={setOpen}>
          <DropdownTrigger asChild>
            <Button size="icon" variant="icon" className="ml-1 h-8 w-8 shrink-0 self-center"><Plus className="h-4 w-4" /></Button>
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
            <NewTabMenuItems
              taskId={task.id}
              onSpawnCli={spawnTab}
              onSpawnShell={spawnShellTab}
              onScratchpad={() => { setOpen(false); void newScratchTab(task.id); }}
              onResume={resumeAndFocus}
              onMore={() => { setOpen(false); setView("history"); }}
            />
          </DropdownMenu>
        </DropdownRoot>
        </div>
      </div>

      {/* Fixed control cluster — never scrolls; always reachable on the right. */}
      <div className="flex shrink-0 items-center gap-1 pl-1 pr-2">
        <Tip content={t("tabBar.broadcastTip")} side="bottom">
          <Button
            size="icon" variant="icon" className="h-8 w-8"
            onClick={() => openBroadcast(task.id)}
          >
            <Megaphone className="h-4 w-4" />
          </Button>
        </Tip>

        <SplitBelowToggle taskId={task.id} />
        <SplitPaneToggle taskId={task.id} />
      </div>
      </div>
    </div>
  );
}

/** Button that creates a new vertical split pane to the right (⌘D). */
function SplitPaneToggle({ taskId }: { taskId: string }) {
  const { t } = useTranslation("task");
  const hasSplit = useApp(s => !!s.splitTree[taskId]);
  const splitPane = useApp(s => s.splitPane);
  return (
    <Tip content={t("tabBar.splitRightTip")} side="bottom">
      <Button
        size="icon" variant="icon" className="h-8 w-8"
        onClick={() => splitPane(taskId, 'v')}
      >
        <SquareSplitHorizontal className={cn("h-4 w-4", hasSplit && "text-[var(--color-accent)]")} />
      </Button>
    </Tip>
  );
}

/** Split the focused pane below (horizontal divider, ⇧⌘D). */
function SplitBelowToggle({ taskId }: { taskId: string }) {
  const { t } = useTranslation("task");
  const hasSplit = useApp(s => !!s.splitTree[taskId]);
  const splitPane = useApp(s => s.splitPane);
  return (
    <Tip content={t("tabBar.splitBelowTip")} side="bottom">
      <Button
        size="icon" variant="icon" className="h-8 w-8"
        onClick={() => splitPane(taskId, 'h')}
      >
        <SquareSplitVertical className={cn("h-4 w-4", hasSplit && "text-[var(--color-accent)]")} />
      </Button>
    </Tip>
  );
}

export function TabPill({ task, tab, active, paneFocused, compact, onSelect, onClose, onUnpin, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename, dragging, dragTx, onStartDrag }: {
  task: Task; tab: Tab; active: boolean;
  /** True when this pill's pane is the focused one. The active tab keeps its
   *  bg highlight regardless, but only shows the accent underline when its
   *  pane is focused — so across a split only ONE tab reads as fully active. */
  paneFocused: boolean;
  /** Right-split strip: size to content (narrower) instead of the main strip's
   *  fit-three-tabs flex basis. */
  compact?: boolean;
  onSelect: () => void; onClose: () => void;
  /** A PINNED pill trades its close × for a pin that unpins on click, so the
   *  tab the user marked as important is never one stray click from a dead
   *  PTY. ⌘W and the context menu's Close stay as the ways out. */
  onUnpin: () => void;
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
  const { t } = useTranslation("task");
  const { t: tChrome } = useTranslation("chrome");
  const queueRunning = tab.type === "terminal" && !!tab.queueActive;
  const agents = useApp(s => s.agents);
  // Experimental work-in-progress spinner — opt-in (Settings → Notifications).
  // The "working" state is force-cleared by TerminalPane's demoters /
  // absolute ceiling, so the spinner can't spin forever.
  const workingIndicator = usePrefs(s => s.workingIndicator);
  // Its own opt-out (Settings -> Notifications). Off falls back to the
  // background-work ring, because the turn is still not over.
  const partialDoneIndicator = usePrefs(s => s.partialDoneIndicator);
  // The tab strip used to draw done and the bell whatever these said, so
  // turning them off quietened the sidebar and left the strip lit.
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  // Failed run/setup tab (GH #54 + exit-code plumbing): the script exited
  // non-zero. Outranks everything else — a red flag on a background setup
  // tab is the whole point of surfacing it without stealing focus.
  const showFailed  = tab.type === "terminal" && !!(tab as TerminalTab).runTab?.failed;
  const showBell    = attentionIndicator && !showFailed && reason === "attention";
  const showDone    = settledHighlight && !showFailed && !showBell && workState === "done";
  const showWorking = workingIndicator && !showFailed && !showBell && !showDone && workState === "working";
  // Work the agent delegated and has not finished (lib/delegatedWork.ts). It
  // qualifies the badge rather than replacing it: with `working` it says the
  // model loop has STOPPED and the spinner is waiting on a subagent, not
  // thinking; with `done` it says the turn ended and left a shell running.
  const delegated = tab.type === "terminal" ? tab.delegatedWork : null;
  const delegatedText = delegated ? delegatedTitle(delegated, tChrome) : "";
  // Some of it came back, the rest runs on. Outranks done (it is the more
  // accurate statement about the same moment) but never a bell.
  const showPartial = workingIndicator && partialDoneIndicator && !showFailed && !showBell && !!delegated?.partial;
  // The turn is over and something it started is still running. Lowest
  // priority in the chain below: it draws only in a slot nothing else wanted,
  // and it is a hollow ring rather than the done bullet because the done was
  // already announced. Without it the decoration is invisible in the common
  // case, since a done on the tab you are WATCHING is acknowledged straight to
  // idle and idle draws no badge at all.
  const showDelegated = workingIndicator && !showFailed && !showBell && !showDone && !showWorking && !!delegated;
  // The ring stands in for the spinner whenever the agent is only WAITING on
  // delegated work: its own loop has stopped, so a spinner claims a model is
  // running. See `BackgroundRing`.
  const ringInsteadOfSpinner = showWorking && !!delegated && !showPartial;
  // Something already occupies the trailing slot at rest, so the action button
  // (close ×, or the pin on a pinned tab) waits for hover.
  const slotTaken = showFailed || showBell || showDone || showWorking || showDelegated || showPartial || !!tab.dirty;
  const iconId = tab.type === "terminal" ? resolveIconId(tab.cli, agents) : "";
  const color = tab.type === "terminal" ? CLI_BRAND_COLOR[iconId] : "text-[var(--color-fg-dim)]";
  const isRenaming = renaming !== null;
  const rawTitle = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
  const visibleTitle =
    tab.type === "terminal" && !tab.customTitle
      ? formatTerminalTitle(rawTitle, tab.cli, showWorking)
      : rawTitle;

  // Reveal the pill when it becomes active — keyboard tab switches (⇧⌘[/],
  // ⌘1..9, cross-pane cycling) can land on a tab scrolled out of the strip's
  // viewport. inline:'nearest' only scrolls the horizontal strip when needed;
  // block:'nearest' keeps ancestors from scrolling vertically.
  const pillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active && !dragging) {
      pillRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active, dragging]);

  let fileIcon: string | null = null;
  if ((tab.type === "edit" || tab.type === "diff" || tab.type === "external") && (tab as any).path) {
    const path = (tab as any).path;
    const name = path.split("/").pop() || tab.title;
    fileIcon = fileIconUrl(name);
  }
  // Folder tabs (issue #151) get the tree's folder icon, matching how the
  // same directory reads in the sidebar. The task root has an empty path,
  // so fall back to the tab title for its name-based icon lookup.
  if (tab.type === "dir") {
    fileIcon = folderIconUrl((tab as any).path.split("/").pop() || tab.title, true);
  }

  return (
    <div
      ref={pillRef}
      data-tab-id={tab.id}
      // The selected state as a DOM fact, so a spec can assert what the user
      // sees (which pill is lit) rather than the store field behind it.
      data-active={active ? "" : undefined}
      {...(tab.pinned ? { "data-pinned": "" } : null)}
      // Start a pointer-drag for reordering, except while renaming (so the
      // inline input handles text selection / caret normally).
      onPointerDown={(e) => { if (!isRenaming) onStartDrag(e); }}
      onClick={() => { if (!isRenaming) onSelect(); }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (tab.preview) {
          useApp.getState().persistTab(task.id, tab.id);
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
        // A PINNED pill gets an outright FIXED width instead. It lives in the
        // strip's shrink-to-fit region, so a content-sized one re-measures on
        // every OSC title the agent emits, resizing itself and shoving the whole
        // scrolling remainder sideways. A flex-basis is not enough here: the
        // region is a scroll container, whose intrinsic width does not track a
        // shrinkable item's basis, so the pill collapsed to its min-w. The value
        // equals max-w below, so an uncrowded pinned tab is exactly as wide as
        // its unpinned neighbours; past the region's cap it scrolls.
        ...(tab.pinned
          ? { flex: "0 0 auto", width: compact ? 220 : 260 }
          : compact ? null : { flex: "0 1 calc((100% - 5rem) / 3)" }),
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
          {(tab.type === "edit" || tab.type === "dir" || tab.type === "external") && fileIcon && <img src={fileIcon} alt="" className="h-4 w-4 shrink-0 file-icon" />}
          {tab.type === "diff" && (fileIcon ? <img src={fileIcon} alt="" className="h-4 w-4 shrink-0 file-icon" /> : <GitCompare className="h-4 w-4" />)}
        </span>
      )}
      {/* Running message queue (ralph loop) — subtle accent marker. */}
      {queueRunning && (
        <Repeat className="h-3 w-3 shrink-0 text-[var(--color-accent)]" aria-label={t("tabBar.queueRunningAria")} />
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
        // The work state rides the TITLE, not the badge, and that is not a
        // convenience. The badge sits in a slot the close button takes over on
        // hover (`group-hover:opacity-0` below), so its own tooltip can never
        // be reached by a pointer: you hover the mark and get "Close tab". The
        // name is the one part of the pill nothing covers.
        <span
          className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}
          title={[
            tab.liveTitle && !tab.customTitle ? tab.liveTitle : "",
            delegatedText,
          ].filter(Boolean).join("\n") || undefined}
        >
          {visibleTitle}
        </span>
      )}
      {/* Run tabs (GH #54): inline run controls, always visible — the pill IS
          the run toolbar. ptyId is cleared on process exit, so its presence ≈
          "running": running → restart + red stop; stopped → a single play.
          <button> elements are skipped by the drag guards, so these never
          start a tab drag. */}
      {!isRenaming && tab.type === "terminal" && (tab as TerminalTab).runTab && (() => {
        const running = !!(tab as TerminalTab).ptyId;
        const rerun = (e: React.MouseEvent) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("termic-run-tab-restart", { detail: { tabId: tab.id } }));
        };
        return (
          <span className="flex shrink-0 items-center gap-0.5">
            {running ? (
              <>
                <button
                  title={t("tabBar.restartRunTip")}
                  onClick={rerun}
                  className="rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
                ><RotateCw className="h-3 w-3" /></button>
                {/* Stop matches the footer toolbar's Stop: error-red. */}
                <button
                  title={t("tabBar.stopTip")}
                  onClick={(e) => {
                    e.stopPropagation();
                    const ptyId = (tab as TerminalTab).ptyId;
                    if (ptyId) ptyKill(ptyId).catch(() => {});
                  }}
                  className="rounded p-0.5 text-[var(--color-err)] hover:bg-[var(--color-bg-3)] hover:opacity-80"
                ><Square className="h-3 w-3" fill="currentColor" /></button>
              </>
            ) : (
              <button
                title={t("tabBar.runTip")}
                onClick={rerun}
                className="rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
              ><Play className="h-3 w-3" /></button>
            )}
          </span>
        );
      })()}
      {/* Trailing slot — iTerm2 convention: status badge / dirty dot by
          default; the action button (close ×, or the unpin pin on a pinned
          tab) on hover. Fixed cell so the pill never jiggles.
          Priority: failed > attention > done > dirty > none. */}
      {!isRenaming && (
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {(showFailed || showBell || showDone || showWorking || showDelegated || showPartial) ? (
            <span
              // DOM hook for the e2e suite. The badge is the user-visible
              // proof of a tab's work state, so specs assert on this instead
              // of reading `tab.workState` out of the store. Keep the value
              // in sync with the priority chain above.
              data-testid="work-badge"
              data-work-state={
                showFailed ? "failed" : showBell ? "attention" : showPartial ? "partial"
                  : showDone ? "done" : showWorking ? "working" : "delegated"
              }
              // Separate attribute, not a fifth `data-work-state`: it can
              // accompany either of two states and specs assert on both.
              data-delegated={delegated ? delegated.label : undefined}
              // Own compositing layer for good, not just while the
              // transition runs: WebKit snaps a layer to whole pixels, so a
              // badge at a fractional offset jumps when one appears on
              // hover. See the sidebar's copies and Dialog's content box.
              className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0 [transform:translate3d(0,0,0)]"
            >
              {showFailed && (
                <span className="text-[var(--color-err)]" title={t("tabBar.failedTip")}>
                  <AlertTriangle className="h-3.5 w-3.5" />
                </span>
              )}
              {showBell && (
                <span className="text-[var(--color-warn)]" title={tChrome("taskWorkBadge.attention")}>
                  <Bell className="h-3.5 w-3.5" strokeWidth={2.5} />
                </span>
              )}
              {showPartial && (
                <span
                  title={delegatedText}
                  aria-label={delegatedText}
                >
                  <span
                    className="block h-2 w-2 rounded-full border-[1.5px]"
                    style={{ borderColor: "var(--color-info)" }}
                  />
                </span>
              )}
              {!showPartial && showDone && (
                <span
                  title={delegatedText
                    ? tChrome("taskWorkBadge.doneDelegatedRunning", { held: delegatedText })
                    : tChrome("taskWorkBadge.done")}
                  aria-label={tChrome("taskWorkBadge.doneAria")}
                >
                  <span
                    className="block h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--color-info)" }}
                  />
                </span>
              )}
              {showDelegated && !showPartial && (
                <span
                  className="text-[var(--color-fg-faint)]"
                  title={delegatedText}
                  aria-label={delegatedText}
                >
                  <BackgroundRing size={14} />
                </span>
              )}
              {showWorking && !showPartial && (
                <span
                  className="text-[var(--color-fg-faint)]"
                  title={ringInsteadOfSpinner ? delegatedText : tChrome("taskWorkBadge.working")}
                  aria-label={ringInsteadOfSpinner ? delegatedText : tChrome("taskWorkBadge.workingAria")}
                >
                  {/* The ring, not the spinner, whenever the model has stopped
                      and only delegated work is outstanding. A turn waiting on
                      a monitoring agent can run for hours, and a 1s spinner
                      reads as a hang long before that. */}
                  {ringInsteadOfSpinner ? <BackgroundRing size={14} /> : <Spinner size={14} />}
                </span>
              )}
            </span>
          ) : tab.type === "scratch" && tab.unseen ? (
            // Written by an agent since you last looked. A pad is dirty for
            // its whole life, so the grey dot says nothing; this ring (the
            // partial-done shape, in the done colour) replaces it until the
            // tab is shown.
            <span
              data-testid="pad-unseen"
              title={t("tabBar.unseenTip")}
              aria-label={t("tabBar.unseenTip")}
              className="absolute block h-2 w-2 rounded-full border-[1.5px] transition-opacity group-hover:opacity-0"
              style={{ borderColor: "var(--color-info)" }}
            />
          ) : tab.dirty && (
            <span
              aria-hidden
              title={t("tabBar.dirtyTip")}
              className="absolute h-[7px] w-[7px] rounded-full bg-[var(--color-fg-dim)] transition-opacity group-hover:opacity-0"
            />
          )}
          {tab.pinned ? (
            // No close × on a pinned tab: the affordance would contradict the
            // intent, and one stray click would kill a live PTY (a secondary
            // agent tab is forgotten for good, see closeTab.ts). The pin is
            // always on show when nothing outranks it, so pinned state can
            // never hide behind a status badge.
            <button
              title={t("tabBar.unpinTip")}
              className={cn(
                "absolute inset-0 flex items-center justify-center rounded p-0.5 text-[var(--color-fg-faint)] transition-opacity hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
                slotTaken && "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => { e.stopPropagation(); onUnpin(); }}
            ><Pin className="h-3 w-3" /></button>
          ) : (
            <button
              title={t("tabBar.closeTip")}
              className={cn(
                "absolute inset-0 flex items-center justify-center rounded p-0.5 text-[var(--color-fg-faint)] transition-opacity hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
                (!active || slotTaken) && "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
            ><X className="h-3 w-3" /></button>
          )}
        </span>
      )}
    </div>
  );
}
