// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useRef, useState } from "react";
import type { Workspace, Tab } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, SquareSplitVertical, Check, Bell } from "lucide-react";
import { Tip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";

const CLIS = ["claude", "gemini", "codex"] as const;

export function TabBar({ ws }: { ws: Workspace }) {
  const tabs = useWorkspaceTabs(ws.id);
  const activeId = useActiveTabId(ws.id);
  const setActive = useApp(s => s.setActiveTabId);
  const closeTab = useApp(s => s.closeTab);
  const addTab = useApp(s => s.addTab);
  const renameTab = useApp(s => s.renameTab);
  const [open, setOpen] = useState(false);
  // When spawnTab fires, suppress Radix's auto focus-return so it
  // doesn't yank focus back to the '+' trigger before our terminal-
  // focus call lands.
  const suppressDropdownReturn = useRef(false);
  // Inline rename state: which tab id is being renamed + its draft value.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  function commitRename() {
    if (!renaming) return;
    renameTab(ws.id, renaming.id, renaming.value);
    setRenaming(null);
  }

  function spawnTab(cli: string) {
    const newId = crypto.randomUUID();
    suppressDropdownReturn.current = true;
    addTab(ws.id, { id: newId, type: "terminal", title: cli, cli });
    setOpen(false);
    // Focus the NEW tab's terminal so the user can type immediately.
    // All workspace tabs stay mounted (visibility-toggle keep-alive),
    // so we have to target this specific one via data-tab-id rather
    // than blindly grabbing the first .xterm-helper-textarea on the
    // page (which would be the previously-active tab, leaving focus
    // on the dropdown's '+' button after it closes). Poll because the
    // TerminalPane spawn effect commits a few frames later.
    const tryFocus = (tries = 40) => {
      const host = document.querySelector(`[data-tab-id="${newId}"]`);
      const el = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      if (el) { el.focus(); return; }
      if (tries > 0) setTimeout(() => tryFocus(tries - 1), 25);
    };
    tryFocus();
  }

  return (
    <div className="termic-tabstrip flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 overflow-x-auto overflow-y-hidden">
      {tabs.map(t => (
        <TabPill
          key={t.id} ws={ws} tab={t} active={t.id === activeId}
          onSelect={() => setActive(ws.id, t.id)} onClose={() => closeTab(ws.id, t.id)}
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
          {CLIS.map(c => (
            <DropdownItem key={c} onSelect={() => spawnTab(c)}>
              <span className={CLI_BRAND_COLOR[c]}><CliIcon cli={c} className="h-4 w-4" /></span>
              {c}
            </DropdownItem>
          ))}
        </DropdownMenu>
      </DropdownRoot>

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
        size="icon" variant="icon" className="ml-auto"
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
      className={cn(
        // flex-[1_1_0] makes each tab share the available bar width
        // equally instead of sizing to its label's intrinsic width.
        // min-w floors so they're still readable when many tabs are
        // open; max-w caps so a single tab on a wide bar doesn't
        // become an enormous pill. Combined effect: tabs feel stable
        // in width even when titles change (Working… / Ready /
        // Action Required all map to the same slot).
        "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors border",
        "flex-[1_1_0] min-w-[140px] max-w-[260px]",
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
      {/* Close button — ALWAYS visible (was hover-only), and shown
          on every tab including the default one. Closing the very
          last tab puts the workspace to sleep (closeTab in the app
          store clears activeWorkspaceId in that branch). Rename
          lives behind dbl-click on the title; no pencil affordance
          to keep the tab compact. */}
      {!isRenaming && (
        <button
          title="Close tab"
          className="rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        ><X className="h-3 w-3" /></button>
      )}
    </div>
  );
}
