// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, Tab, TerminalTab, Agent } from "@/lib/types";
import { useApp, useTaskTabs, useActiveTabId, type ClosedTabEntry } from "@/store/app";
import { getAllLeaves } from "@/lib/splitTree";
import { useTabStripDrag } from "./useTabStripDrag";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL, resolveIconId } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, SquareSplitVertical, SquareSplitHorizontal, TerminalSquare, Bell, Megaphone, Repeat, Loader2, RotateCw, Square, Play, AlertTriangle } from "lucide-react";
import { ptyKill } from "@/lib/ipc";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { requestCloseTab } from "@/lib/closeTab";
import { focusMainTab } from "@/lib/tabFocus";
import { visibleCliIds, agentDisplayName, isTerminalEntry } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { formatTerminalTitle } from "@/lib/terminalTitle";
import { fileIconUrl } from "@/lib/explorer/iconResolver";

const CLIS = ["claude", "codex", "agy", "grok", "opencode"] as const;

// Stable reference for the "no closed tabs yet" case. `s.closedTabs[task.id]
// ?? []` would mint a NEW array on every selector call, which Zustand's
// default Object.is comparison treats as "changed" — re-rendering TabBar on
// every unrelated store write (PTY output ticks etc) and, worse, feeding a
// runaway render loop. A shared empty array keeps the reference stable.
const NO_CLOSED_TABS: ClosedTabEntry[] = [];

/** Compact "10m" / "17h" / "2d" label for a closed-tab timestamp. Closed
 *  tabs are always recent (session-only list), so minute/hour granularity
 *  is enough — no need for History's day/week/month buckets. Terse on
 *  purpose: it sits inline before the row's title, one row per line. */
function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "Resume" section rows — recently closed secondary agent tabs (see
 *  `ClosedTabEntry`). Icon uses the same resolveIconId/CLI_BRAND_COLOR
 *  pairing as TabPill so a resumed tab's row matches the tab it becomes. */
function ResumeMenuItems({ entries, agents, onResume }: {
  entries: ClosedTabEntry[]; agents: Agent[]; onResume: (entryId: string) => void;
}) {
  return (
    <>
      {entries.map(entry => {
        const iconId = resolveIconId(entry.cli, agents);
        return (
          <DropdownItem key={entry.id} onSelect={() => onResume(entry.id)} className="items-center">
            <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={iconId} className="h-4 w-4" />
            </span>
            {/* Fixed-width right-aligned age so the titles line up. */}
            <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-[var(--color-fg-faint)]">
              {relativeTime(entry.closedAt)}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
          </DropdownItem>
        );
      })}
    </>
  );
}

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

export function TabBar({ task }: { task: Task }) {
  const allTabsRaw = useTaskTabs(task.id);
  // Main strip shows only non-pane tabs (split-pane tabs live in SplitView).
  const tabs = allTabsRaw.filter(t => !(t as import("@/lib/types").TerminalTab).paneId);
  const activeId = useActiveTabId(task.id);
  const setActive = useApp(s => s.setActiveTabId);
  const addTab = useApp(s => s.addTab);
  const reorderTab = useApp(s => s.reorderTab);
  const renameTab = useApp(s => s.renameTab);
  const stripRef = useRef<HTMLDivElement>(null);

  // Hide disabled / not-installed agents from the + (new agent) menu.
  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const visibleClis = visibleCliIds(registry.map(a => a.id), registry, detectedClis);
  const customTerminals = useMemo(
    () => registry.filter(a => isTerminalEntry(a) && !a.disabled),
    [registry],
  );
  const openBroadcast = useUI(s => s.openBroadcast);
  const closedTabs = useApp(s => s.closedTabs[task.id] ?? NO_CLOSED_TABS);
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

  const { dragId, dragTx, suppressClickRef, startDrag } = useTabStripDrag({
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
            key={t.id} task={task} tab={t} active={t.id === activeId} paneFocused={mainFocused}
            // focusMainTab: keyboard focus must follow the click into the tab's
            // content (terminal / editor) — otherwise the previously focused
            // pane keeps DOM focus and ⌘W acts on the wrong pane.
            onSelect={() => { if (suppressClickRef.current) return; setActive(task.id, t.id); focusMainTab(t.id); }}
            onClose={() => requestCloseTab(task.id, t.id)}
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
            <DropdownLabel>New terminal</DropdownLabel>
            <ShellTerminalItem onSelect={() => spawnShellTab()} />
            <CliMenuItems entries={customTerminals} onSpawn={spawnTab} />
            <DropdownSeparator />
            <DropdownLabel>New agent</DropdownLabel>
            <CliMenuItems entries={registry.filter(a => visibleClis.has(a.id))} onSpawn={spawnTab} />
            {closedTabs.length > 0 && (
              <>
                <DropdownSeparator />
                <DropdownLabel>Resume</DropdownLabel>
                <ResumeMenuItems entries={closedTabs} agents={registry} onResume={resumeAndFocus} />
                <DropdownItem onSelect={() => { setOpen(false); setView("history"); }}>
                  More…
                </DropdownItem>
              </>
            )}
          </DropdownMenu>
        </DropdownRoot>
      </div>

      {/* Fixed control cluster — never scrolls; always reachable on the right. */}
      <div className="flex shrink-0 items-center gap-1 pl-1 pr-2">
        <Tip content="Broadcast a message to all agents from this task (⇧⌘B)" side="bottom">
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
  const hasSplit = useApp(s => !!s.splitTree[taskId]);
  const splitPane = useApp(s => s.splitPane);
  return (
    <Tip content="Split right (⌘D)" side="bottom">
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
  const hasSplit = useApp(s => !!s.splitTree[taskId]);
  const splitPane = useApp(s => s.splitPane);
  return (
    <Tip content="Split below (⇧⌘D)" side="bottom">
      <Button
        size="icon" variant="icon" className="h-8 w-8"
        onClick={() => splitPane(taskId, 'h')}
      >
        <SquareSplitVertical className={cn("h-4 w-4", hasSplit && "text-[var(--color-accent)]")} />
      </Button>
    </Tip>
  );
}

export function TabPill({ task, tab, active, paneFocused, compact, onSelect, onClose, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename, dragging, dragTx, onStartDrag }: {
  task: Task; tab: Tab; active: boolean;
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
  // Failed run/setup tab (GH #54 + exit-code plumbing): the script exited
  // non-zero. Outranks everything else — a red flag on a background setup
  // tab is the whole point of surfacing it without stealing focus.
  const showFailed  = tab.type === "terminal" && !!(tab as TerminalTab).runTab?.failed;
  const showBell    = !showFailed && reason === "attention";
  const showDone    = !showFailed && !showBell && workState === "done";
  const showWorking = workingIndicator && !showFailed && !showBell && !showDone && workState === "working";
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
  if ((tab.type === "edit" || tab.type === "diff") && (tab as any).path) {
    const path = (tab as any).path;
    const name = path.split("/").pop() || tab.title;
    fileIcon = fileIconUrl(name);
  }

  return (
    <div
      ref={pillRef}
      data-tab-id={tab.id}
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
                  title="Restart run"
                  onClick={rerun}
                  className="rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
                ><RotateCw className="h-3 w-3" /></button>
                {/* Stop matches the footer toolbar's Stop: error-red. */}
                <button
                  title="Stop"
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
                title="Run"
                onClick={rerun}
                className="rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
              ><Play className="h-3 w-3" /></button>
            )}
          </span>
        );
      })()}
      {/* Trailing slot — iTerm2 convention: status badge / dirty dot
          by default; close × on hover. Fixed cell so the pill never
          jiggles. Priority: failed > attention > done > dirty > none. */}
      {!isRenaming && (
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {(showFailed || showBell || showDone || showWorking) ? (
            <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0">
              {showFailed && (
                <span className="text-[var(--color-err)]" title="Exited with an error, click Restart to retry">
                  <AlertTriangle className="h-3.5 w-3.5" />
                </span>
              )}
              {showBell && (
                <span className="text-[var(--color-warn)]" title="Agent needs your input">
                  <Bell className="h-3.5 w-3.5" strokeWidth={2.5} />
                </span>
              )}
              {showDone && (
                <span title="Agent finished a turn" aria-label="Work done">
                  <span
                    className="block h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--color-info)" }}
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
              (!active || tab.dirty || showFailed || showBell || showDone || showWorking) && "opacity-0 group-hover:opacity-100",
            )}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          ><X className="h-3 w-3" /></button>
        </span>
      )}
    </div>
  );
}
