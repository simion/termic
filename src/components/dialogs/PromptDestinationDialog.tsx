// "Run '<title>'" destination picker — where should this prompt go? A
// running agent (send / queue), or a new agent with the CLI of your choice.
// Shared by the Prompts dropdown (UnifiedBar) and the ⌥⌘P prompt palette's
// fallback (src/lib/promptFire.ts's `fireOrPickDestination`, used when there's
// no focused live agent to guess at). Self-manages via useUI, same pattern as
// every other dialog in components/dialogs/ — see Dialogs.tsx.

import { useMemo } from "react";
import { useApp, useActiveTask } from "@/store/app";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { visibleCliIds, isTerminalEntry, tabLabel } from "@/lib/agents";
import { findLeaf } from "@/lib/splitTree";
import { runPrompt } from "@/lib/runPrompt";
import type { TerminalTab } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";

export function PromptDestinationDialog() {
  const promptFire = useUI(s => s.promptFire);
  const closePromptFire = useUI(s => s.closePromptFire);
  const setPromptFireBody = useUI(s => s.setPromptFireBody);
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const task = useActiveTask();
  const taskTabs = useApp(s => (task ? s.tabs[task.id] : undefined));
  const liveAgents = (taskTabs ?? []).filter(
    (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId && !(t as TerminalTab).runTab,
  );
  const focusedAgentId = useApp(s => {
    if (!task) return undefined;
    const tree = s.splitTree[task.id];
    if (tree) {
      const leaf = findLeaf(tree, s.activePaneId[task.id] ?? "");
      if (leaf?.activeTabId) return leaf.activeTabId;
    }
    return s.activeTab[task.id];
  });
  // Spawnable agents for "start a new agent" — same list the new-tab (+) menu offers.
  const newAgentChoices = useMemo(() => {
    const vis = visibleCliIds(agents.map(x => x.id), agents, detectedClis);
    return agents.filter(a => vis.has(a.id) && !isTerminalEntry(a));
  }, [agents, detectedClis]);

  if (!promptFire || !task) return null;
  const { prompt, body } = promptFire;

  return (
    <AppDialog
      open
      onOpenChange={(v) => { if (!v) closePromptFire(); }}
      title={`Run "${prompt.title}"`}
      description="Tweak the prompt if needed, then pick where it runs."
      className="max-w-5xl"
    >
      <div className="mt-1 flex h-[58vh] gap-4">
        {/* Left: editable prompt for THIS send (does not change the saved
            library prompt). */}
        <textarea
          value={body}
          onChange={(e) => setPromptFireBody(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="h-full min-w-0 flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />

        {/* Right: where to run it. */}
        <div className="flex w-[260px] shrink-0 flex-col gap-3 overflow-y-auto pr-0.5">
          {liveAgents.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="px-0.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">Send to a running agent</div>
              {liveAgents.map(a => {
                const current = a.id === focusedAgentId;
                const busy = a.workState === "working";
                return (
                  <button
                    key={a.id}
                    onClick={() => { runPrompt(task.id, { ...prompt, body }, { kind: "agent", tabId: a.id }); closePromptFire(); }}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      current
                        ? "border-[var(--color-border)] bg-[var(--color-bg-2)]"
                        : "border-[var(--color-border)] hover:border-[var(--color-accent-soft)] hover:bg-[var(--color-hover)]",
                    )}
                  >
                    <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(a.cli, agents)])}>
                      <CliIcon cli={resolveIconId(a.cli, agents)} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--color-fg)]">
                        {tabLabel(a)}
                      </span>
                      {(current || busy) && (
                        <span className="block text-[10.5px]">
                          {current && <span className="text-[var(--color-accent)]">current</span>}
                          {current && busy && <span className="text-[var(--color-fg-faint)]"> · </span>}
                          {busy && <span className="text-[var(--color-fg-faint)]">busy</span>}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex flex-col gap-0.5">
            <div className="mb-0.5 flex items-center gap-1 px-0.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">
              <Plus className="h-3 w-3" /> Start a new agent
            </div>
            {newAgentChoices.length === 0 ? (
              <div className="px-0.5 py-1 text-[12.5px] text-[var(--color-fg-faint)]">No agents available.</div>
            ) : newAgentChoices.map(a => (
              <button
                key={a.id}
                onClick={() => { runPrompt(task.id, { ...prompt, body }, { kind: "new", cli: a.id }); closePromptFire(); }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-hover)]"
              >
                <span className={cn("shrink-0 opacity-80", CLI_BRAND_COLOR[a.icon_id])}>
                  <CliIcon cli={a.icon_id} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-fg-dim)]">{a.display_name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
