// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Workspace, Tab } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, SquareSplitVertical, Bell, Megaphone, ListPlus, Repeat } from "lucide-react";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { requestCloseTab } from "@/lib/closeTab";
import { visibleCliIds, agentDisplayName, workDoneCapable } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/lib/explorer/iconResolver";

const CLIS = ["claude", "codex", "agy", "gemini", "grok"] as const;

export function TabBar({ ws }: { ws: Workspace }) {
  const tabs = useWorkspaceTabs(ws.id);
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
    id: string; grabOffset: number; startX: number; pointerX: number; started: boolean; appliedTx: number;
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
    if (target !== cur) reorderTab(ws.id, d.id, target);
  }

  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    d.pointerX = e.clientX;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < 5) return; // below the drag threshold
      d.started = true;
      setDragId(d.id);
    }
    setDragTx(computeTx(e.clientX));
    maybeReorder(e.clientX);
  }
  function onPointerUp() {
    const d = dragRef.current;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (d?.started) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
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
  const openQueue = useUI(s => s.openQueue);
  // The message queue (ralph loop) advances on work-done, so it's only
  // offered when at least one running agent in the workspace is work-done
  // capable (a shell, or an agent with detection turned off, can't gate it).
  const canQueue = tabs.some(t => t.type === "terminal" && !!t.ptyId && workDoneCapable(t.cli, registry));
  // Live aggregate across the workspace's agents: total pending sends (sum of
  // remaining repeats) and whether any queue is actively draining. Drives the
  // toolbar button's "N queued" indicator for both pending and running states.
  let queuedCount = 0;
  let queueRunning = false;
  for (const t of tabs) {
    if (t.type !== "terminal") continue;
    if (t.queue) for (const q of t.queue) queuedCount += q.remaining;
    if (t.queueActive) queueRunning = true;
  }
  const showQueueBadge = queuedCount > 0 || queueRunning;
  const [open, setOpen] = useState(false);
  // When spawnTab fires, suppress Radix's auto focus-return so it
  // doesn't yank focus back to the '+' trigger before our terminal-
  // focus call lands.
  const suppressDropdownReturn = useRef(false);
  // Inline rename state: which tab id is being renamed + its draft value.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

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
    <div ref={stripRef} className="termic-tabstrip flex h-9 shrink-0 items-center gap-0 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] pl-2 pr-2 overflow-x-auto overflow-y-hidden">
      {tabs.map(t => (
        <TabPill
          key={t.id} ws={ws} tab={t} active={t.id === activeId}
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
          <DropdownLabel>New agent</DropdownLabel>
          {registry.filter(a => visibleClis.has(a.id)).map(a => (
            <DropdownItem key={a.id} onSelect={() => spawnTab(a.id)}>
              <span className={cn("shrink-0", CLI_BRAND_COLOR[a.id] || "text-[var(--color-fg-dim)]")}><CliIcon cli={a.id} className="h-4 w-4" /></span>
              {a.display_name}
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownLabel>New terminal</DropdownLabel>
          {/* Plain login shell. "Terminal" is the full-reach shell
              (always offered). When the workspace is sandboxed, the
              user can also spawn one inside the cage. CliIcon keeps
              the glyph aligned + sized exactly like the agent rows. */}
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
        </DropdownMenu>
      </DropdownRoot>

      <div className="ml-auto flex items-center gap-1">
        <Tip
          content={!canQueue
            ? "Run a work-done-capable agent to queue messages"
            : showQueueBadge
              ? `${queuedCount} queued message${queuedCount === 1 ? "" : "s"}${queueRunning ? " (running)" : " (not started)"}`
              : "Queue messages for an agent, sent on each work-done (ralph loop)"}
          side="bottom"
        >
          {/* span wrapper so the tooltip still fires while the button is disabled */}
          <span>
            <Button
              size="icon"
              variant="icon"
              className={cn(
                "h-8",
                showQueueBadge ? "w-auto gap-1.5 px-2" : "w-8",
                queueRunning && "text-[var(--color-accent)]",
              )}
              disabled={!canQueue}
              onClick={() => openQueue(ws.id)}
            >
              <ListPlus className={cn("h-4 w-4 shrink-0", queueRunning && "animate-pulse")} />
              {showQueueBadge && (
                <span className={cn(
                  "text-[12px] font-medium tabular-nums whitespace-nowrap",
                  queueRunning ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]",
                )}>
                  {queuedCount > 0 ? `${queuedCount} queued` : "running"}
                </span>
              )}
            </Button>
          </span>
        </Tip>

        <Tip content="Broadcast a message to all agents from this workspace (⇧⌘B)" side="bottom">
          <Button
            size="icon" variant="icon" className="h-8 w-8"
            onClick={() => openBroadcast(ws.id)}
          >
            <Megaphone className="h-4 w-4" />
          </Button>
        </Tip>

        <SplitToggle wsId={ws.id} />
      </div>
    </div>
  );
}

/** Toggle a horizontal split with a scratch shell on the bottom half of the
 *  main pane. State is per-workspace (so each workspace remembers its own
 *  split preference) and persists via the app store. */
function SplitToggle({ wsId }: { wsId: string }) {
  const split = useApp(s => !!s.terminalSplit[wsId]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);
  return (
    <Tip content={split ? "Close split terminal" : "Split: open shell below"} side="bottom">
      <Button
        size="icon" variant="icon" className="h-8 w-8"
        onClick={() => toggleSplit(wsId)}
      >
        <SquareSplitVertical className={cn("h-4 w-4", split && "text-[var(--color-accent)]")} />
      </Button>
    </Tip>
  );
}

function TabPill({ ws, tab, active, onSelect, onClose, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename, dragging, dragTx, onStartDrag }: {
  ws: Workspace; tab: Tab; active: boolean; onSelect: () => void; onClose: () => void;
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
  const showBell    = reason === "attention";
  const showDone    = !showBell && workState === "done";
  const color = tab.type === "terminal" ? CLI_BRAND_COLOR[tab.cli] : "text-[var(--color-fg-dim)]";
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
        // it beats sibling stacking contexts.
        ...(dragging ? { transform: `translateX(${dragTx}px)`, zIndex: 30 } : null),
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
          {tab.type === "terminal" && <CliIcon cli={tab.cli} className="h-4 w-4" />}
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
          {(showBell || showDone) ? (
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
              (!active || tab.dirty || showBell || showDone) && "opacity-0 group-hover:opacity-100",
            )}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          ><X className="h-3 w-3" /></button>
        </span>
      )}
      {active && (
        <span className="absolute inset-x-0 bottom-0 h-[2.5px] bg-[var(--color-accent)]" />
      )}
    </div>
  );
}
