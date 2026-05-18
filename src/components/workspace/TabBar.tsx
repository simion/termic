// Tab strip with CLI brand icons / file glyphs and a "+" popover for new agents.

import { useState } from "react";
import type { Workspace, Tab } from "@/lib/types";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { Plus, X, GitCompare, FileText, Pencil, SquareSplitVertical } from "lucide-react";
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
  // Inline rename state: which tab id is being renamed + its draft value.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  function commitRename() {
    if (!renaming) return;
    renameTab(ws.id, renaming.id, renaming.value);
    setRenaming(null);
  }

  function spawnTab(cli: string) {
    addTab(ws.id, { id: crypto.randomUUID(), type: "terminal", title: cli, cli });
    setOpen(false);
  }

  return (
    <div className="termic-tabstrip flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 overflow-x-auto overflow-y-hidden">
      {tabs.map(t => (
        <TabPill
          key={t.id} ws={ws} tab={t} active={t.id === activeId}
          onSelect={() => setActive(ws.id, t.id)} onClose={() => closeTab(ws.id, t.id)}
          canClose={tabs.length > 1}
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
        <DropdownMenu align="start">
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

function TabPill({ ws: _ws, tab, active, onSelect, onClose, canClose, renaming, onStartRename, onChangeRename, onCommitRename, onCancelRename }: {
  ws: Workspace; tab: Tab; active: boolean; onSelect: () => void; onClose: () => void; canClose: boolean;
  renaming: string | null;  // current draft value while renaming, else null
  onStartRename: () => void;
  onChangeRename: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const isUnread = !!tab.unread;
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
        "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13.5px] transition-colors max-w-[220px] border",
        active
          ? "bg-[var(--color-bg-3)] text-[var(--color-fg)] border-[var(--color-accent-soft)] font-semibold"
          : "border-transparent text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      {isUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />}
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
          className="w-auto min-w-0 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1 text-[13.5px] text-[var(--color-fg)] outline-none"
        />
      ) : (
        <span className="truncate">{tab.title}</span>
      )}
      {!isRenaming && (
        <button
          title="Rename tab"
          className="ml-0.5 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onStartRename(); }}
        ><Pencil className="h-3 w-3" /></button>
      )}
      {canClose && !isRenaming && (
        <button
          title="Close tab"
          className="rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        ><X className="h-3 w-3" /></button>
      )}
    </div>
  );
}
