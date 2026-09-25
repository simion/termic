// The contents of the tab strip's "+" menu (new terminal / new agent /
// resume), extracted so the sidebar task row's "New" submenu (GH #197) shows
// exactly the same options. Users kept right-clicking the sidebar row looking
// for "add another agent to this task" and never found the "+" in the tab bar;
// both entry points now render from here so they cannot drift apart.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Agent } from "@/lib/types";
import { useApp, type ClosedTabEntry } from "@/store/app";
import {
  DropdownItem, DropdownLabel, DropdownSeparator,
  DropdownSub, DropdownSubTrigger, DropdownSubContent,
} from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { visibleCliIds, isTerminalEntry } from "@/lib/agents";
import { NotepadText, History, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Stable reference for the "no closed tabs yet" case. `s.closedTabs[id] ?? []`
// would mint a NEW array on every selector call, which Zustand's default
// Object.is comparison treats as "changed" — re-rendering on every unrelated
// store write (PTY output ticks etc) and, worse, feeding a runaway render loop.
const NO_CLOSED_TABS: ClosedTabEntry[] = [];

/** Compact "10m" / "17h" / "2d" label for a closed-tab timestamp. Closed
 *  tabs are always recent (session-only list), so minute/hour granularity
 *  is enough — no need for History's day/week/month buckets. Terse on
 *  purpose: it sits inline before the row's title, one row per line. */
function relativeTime(iso: string, now: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return now;
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
  const { t } = useTranslation("task");
  return (
    <>
      {entries.map(entry => {
        const iconId = resolveIconId(entry.cli, agents);
        return (
          <DropdownItem key={entry.id} onSelect={() => onResume(entry.id)} className="items-center">
            <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={iconId} className="h-4 w-4" />
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-faint)]">
              {relativeTime(entry.closedAt, t("newTab.now"))}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
          </DropdownItem>
        );
      })}
    </>
  );
}

/** Registry entries rendered as dropdown rows — shared by the "New terminal"
 *  custom entries and the "New agent" list. */
function CliMenuItems({ entries, onSpawn }: { entries: Agent[]; onSpawn: (cli: string) => void }) {
  // The FULL registry, not `entries`: resolving a clone's icon needs its
  // parent, and the parent may be filtered out of the list being rendered.
  const agents = useApp(s => s.agents);
  return (
    <>
      {entries.map(a => (
        <DropdownItem key={a.id} onSelect={() => onSpawn(a.id)}>
          <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(a.id, agents)] || "text-[var(--color-fg-dim)]")}><CliIcon cli={resolveIconId(a.id, agents)} className="h-4 w-4" /></span>
          {a.display_name}
        </DropdownItem>
      ))}
    </>
  );
}

/** The plain "Terminal" entry. Terminals are ALWAYS uncaged now (only agents
 *  run inside the seatbelt — they're the threat model; a shell the user drives
 *  is not). There is no "Sandboxed" shell variant: a caged terminal you type
 *  into yourself made no sense (it just broke git/ssh + shell history). See
 *  issue #32. */
function ShellTerminalItem({ onSelect }: { onSelect: () => void }) {
  const { t } = useTranslation("task");
  return (
    <DropdownItem onSelect={onSelect}>
      <span className="shrink-0 text-[var(--color-fg-dim)]"><CliIcon cli="shell" className="h-4 w-4" /></span>
      {t("newTab.terminal")}
    </DropdownItem>
  );
}

/** Every row of the "+" menu. Reads the agent registry itself (both call
 *  sites need the same filtering); the caller owns what a pick DOES, because
 *  each host has its own close/focus dance.
 *
 *  Mounted only while its menu is open (Radix portals content on open), so
 *  the store subscriptions here cost nothing on a closed menu. */
export function NewTabMenuItems({ taskId, onSpawnCli, onSpawnShell, onScratchpad, onResume, onMore }: {
  taskId: string;
  onSpawnCli: (cli: string) => void;
  onSpawnShell: () => void;
  /** New scratchpad (GH #244) — an untitled buffer in this task's strip. */
  onScratchpad: () => void;
  /** Reopen a closed tab with its original session id. */
  onResume: (entryId: string) => void;
  /** "More…" under Resume — jump to the full History view. */
  onMore: () => void;
}) {
  const { t } = useTranslation("task");
  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const closedTabs = useApp(s => s.closedTabs[taskId] ?? NO_CLOSED_TABS);
  // Hide disabled / not-installed agents from the new-agent list.
  const visibleClis = visibleCliIds(registry.map(a => a.id), registry, detectedClis);
  const customTerminals = useMemo(
    () => registry.filter(a => isTerminalEntry(a) && !a.disabled),
    [registry],
  );

  return (
    <>
      <DropdownLabel>{t("newTab.newTerminal")}</DropdownLabel>
      <ShellTerminalItem onSelect={onSpawnShell} />
      <CliMenuItems entries={customTerminals} onSpawn={onSpawnCli} />
      <DropdownSeparator />
      <DropdownLabel>{t("newTab.newAgent")}</DropdownLabel>
      <CliMenuItems entries={registry.filter(a => visibleClis.has(a.id))} onSpawn={onSpawnCli} />
      <DropdownSeparator />
      <DropdownItem onSelect={onScratchpad} data-testid="new-scratchpad" className="items-center">
        <span className="shrink-0 text-[var(--color-fg-dim)]"><NotepadText className="h-4 w-4" /></span>
        {t("newTab.scratchpad")}
      </DropdownItem>
      {/* Resume is a NESTED submenu, not an inline section. It grows with
          every closed tab, and a flat list of five "Claude Code" rows pushed
          the things you actually came here for (Terminal, the agent list,
          Scratchpad) off the top of a menu that opens under the "+". The
          sidebar's task row already nests its own Resume this way, so both
          entry points now read the same. */}
      {closedTabs.length > 0 && (
        <>
          <DropdownSeparator />
          <DropdownSub>
            <DropdownSubTrigger className="justify-between">
              <span className="flex items-center gap-2">
                <History className="h-4 w-4 text-[var(--color-fg-dim)]" />
                <span>{t("newTab.resume")}</span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
            </DropdownSubTrigger>
            <DropdownSubContent>
              <ResumeMenuItems entries={closedTabs} agents={registry} onResume={onResume} />
              <DropdownItem onSelect={onMore}>{t("newTab.more")}</DropdownItem>
            </DropdownSubContent>
          </DropdownSub>
        </>
      )}
    </>
  );
}
