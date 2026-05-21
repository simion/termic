// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useEffect, useRef, useState } from "react";
import type { Workspace, Tab } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, SquareSplitVertical, Check, Bell, Megaphone } from "lucide-react";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { requestCloseTab } from "@/lib/closeTab";
import { visibleCliIds } from "@/lib/agents";
import { cn } from "@/lib/utils";

const CLIS = ["claude", "gemini", "codex", "agy"] as const;

export function TabBar({ ws }: { ws: Workspace }) {
  const tabs = useWorkspaceTabs(ws.id);
  const activeId = useActiveTabId(ws.id);
  const setActive = useApp(s => s.setActiveTabId);
  const addTab = useApp(s => s.addTab);
  const renameTab = useApp(s => s.renameTab);
  // Hide disabled / not-installed agents from the + (new agent) menu.
  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const visibleClis = visibleCliIds(CLIS, registry, detectedClis);
  const openBroadcast = useUI(s => s.openBroadcast);
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
    addAndFocusTab({ id: crypto.randomUUID(), type: "terminal", title: cli, cli });
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
    <div className="termic-tabstrip flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 overflow-x-auto overflow-y-hidden">
      {tabs.map(t => (
        <TabPill
          key={t.id} ws={ws} tab={t} active={t.id === activeId}
          onSelect={() => setActive(ws.id, t.id)} onClose={() => requestCloseTab(ws.id, t.id)}
          renaming={renaming?.id === t.id ? renaming.value : null}
          onStartRename={() => setRenaming({ id: t.id, value: t.title })}
          onChangeRename={(v) => setRenaming(r => r ? { ...r, value: v } : r)}
          onCommitRename={commitRename}
          onCancelRename={() => setRenaming(null)}
        />
      ))}

      <DropdownRoot open={open} onOpenChange={setOpen}>
        <DropdownTrigger asChild>
          <Button size="icon" variant="icon" className="ml-1"><Plus className="h-4 w-4" /></Button>
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
          {CLIS.filter(c => visibleClis.has(c)).map(c => (
            <DropdownItem key={c} onSelect={() => spawnTab(c)}>
              <span className={CLI_BRAND_COLOR[c]}><CliIcon cli={c} className="h-4 w-4" /></span>
              {CLI_LABEL[c] ?? c}
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

      <Tip content="Broadcast message to agents (⇧⌘B)" side="bottom">
        <Button
          size="icon" variant="icon" className="ml-auto"
          onClick={() => openBroadcast(ws.id)}
        >
          <Megaphone className="h-4 w-4" />
        </Button>
      </Tip>

      <SplitToggle wsId={ws.id} />
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
        size="icon" variant="icon"
        onClick={() => toggleSplit(wsId)}
      >
        <SquareSplitVertical className={cn("h-4 w-4", split && "text-[var(--color-accent)]")} />
      </Button>
    </Tip>
  );
}

function TabPill({ ws: _ws, tab, active, onSelect, onClose, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename }: {
  ws: Workspace; tab: Tab; active: boolean; onSelect: () => void; onClose: () => void;
  renaming: string | null;  // current draft value while renaming, else null
  onStartRename: () => void;
  onChangeRename: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const isUnread = !!tab.unread;
  // Sender-driven status icon on the tab itself. Replaces the old
  // brown unread dot — too generic, no signal about WHY the tab is
  // unread. Now: green ✓ when the agent finished a turn; yellow 🔔
  // when the agent is blocked on the user. BEL / exit reasons fall
  // through to no badge (the tab's own contents already explain).
  const reason = tab.unread?.reason;
  // `idle` is the old stdout-cadence heuristic — too many false
  // positives. Only honor the sender-driven `done` (OSC 9;4 / title
  // classifier) for the green check now.
  const showCheck = reason === "done";
  const showBell  = reason === "attention";
  const color = tab.type === "terminal" ? CLI_BRAND_COLOR[tab.cli] : "text-[var(--color-fg-dim)]";
  const isRenaming = renaming !== null;
  return (
    <div
      onClick={() => { if (!isRenaming) onSelect(); }}
      onDoubleClick={(e) => { e.stopPropagation(); onStartRename(); }}
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
      style={{ flex: "0 1 calc((100% - 5rem) / 3)" }}
      className={cn(
        // min-w floors so tabs stay readable when many are open; max-w
        // caps so a single tab on a wide bar doesn't become an
        // enormous pill. Width stays stable when titles change
        // (Working… / Ready / Action Required all map to one slot).
        "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors border",
        "min-w-[140px] max-w-[260px]",
        // Active state cue: brighter bg + colored border + brighter fg.
        // Used to also use `font-semibold` but a weight change resizes
        // the label's intrinsic width, which made the cell jiggle on
        // every active-tab switch. Visual difference is preserved
        // via the bg+border+text-color trio.
        active
          ? "bg-[var(--color-bg-3)] text-[var(--color-fg)] border-[var(--color-accent-soft)]"
          : "border-transparent text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      {showBell && (
        <span className="shrink-0 text-[var(--color-warn)]" title="Agent needs your input">
          <Bell className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
      )}
      {showCheck && !showBell && (
        <span className="shrink-0 text-[var(--color-ok)]" title="Agent finished a turn">
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
      )}
      <span className={cn("shrink-0", color)}>
        {tab.type === "terminal" && <CliIcon cli={tab.cli} className="h-4 w-4" />}
        {tab.type === "edit"     && <FileText className="h-4 w-4" />}
        {tab.type === "diff"     && <GitCompare className="h-4 w-4" />}
      </span>
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
        <span className="min-w-0 flex-1 truncate" title={tab.liveTitle && !tab.customTitle ? tab.liveTitle : undefined}>
          {tab.customTitle ? tab.title : (tab.liveTitle || tab.title)}
        </span>
      )}
      {/* Trailing slot — close button, or a dirty dot for an edit tab
          with unsaved changes. VS Code convention: the dot sits where
          the × would be and swaps to the × on hover, so the tab never
          jiggles in width. Closing routes through requestCloseTab,
          which confirms before discarding an unsaved buffer. */}
      {!isRenaming && (
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {tab.dirty && (
            <span
              aria-hidden
              title="Unsaved changes"
              className="absolute h-[7px] w-[7px] rounded-full bg-[var(--color-fg-dim)] transition-opacity group-hover:opacity-0"
            />
          )}
          <button
            title="Close tab"
            className={cn(
              "rounded p-0.5 text-[var(--color-fg-faint)] transition-opacity hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
              tab.dirty && "opacity-0 group-hover:opacity-100",
            )}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          ><X className="h-3 w-3" /></button>
        </span>
      )}
    </div>
  );
}
