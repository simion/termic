// Message queue (the "ralph loop") — bottom status-bar control + popover.
//
// Low-friction model: there is NO start/stop. Adding a message activates the
// queue; each time the agent reports work-done the next message is sent
// automatically (the draining engine lives in TerminalPane). The user just
// adds messages and removes them; that's it.
//
// Layout mirrors a chat composer: the queue grows top→bottom (head = next to
// send, at the top), and the input sits at the BOTTOM where you naturally add
// the next item. Queues are per-agent, so a selector appears when more than
// one work-done-capable agent is running in the workspace.

import { useMemo, useState } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { workDoneCapable } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { MessageSquarePlus, X, Repeat, CornerDownLeft } from "lucide-react";
import type { TerminalTab, QueueItem } from "@/lib/types";

const MAX_REPEAT = 99;

function tabLabel(t: TerminalTab): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

export function MessageQueueButton({ wsId, compact = false, className }: {
  wsId: string;
  /** Icon-only rendering for tight spots like the split terminal's tab strip
   *  (vs. icon + "Queue messages" text in the bottom status bar). */
  compact?: boolean;
  /** Extra classes for the trigger wrapper (e.g. `ml-auto` to sit by a caret). */
  className?: string;
}) {
  const tabsForWs = useApp(s => s.tabs[wsId]);
  const activeTabId = useApp(s => s.activeTab[wsId]);
  const agents = useApp(s => s.agents);
  const patchTab = useApp(s => s.patchTab);

  // Only work-done-capable agent tabs with a live PTY can host a queue — the
  // loop advances on work-done, which shells / detection-off agents never emit.
  const targets = useMemo<TerminalTab[]>(
    () => (tabsForWs || []).filter(
      (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId && workDoneCapable(t.cli, agents),
    ),
    [tabsForWs, agents],
  );
  const canQueue = targets.length > 0;

  // The button badge reflects ONLY the active agent (the one in the main pane),
  // not a workspace-wide sum — a count from a different agent's queue here is
  // confusing. The popover still lists every agent via the selector.
  const activeAgent = targets.find(t => t.id === activeTabId);
  const queuedCount = (activeAgent?.queue ?? []).reduce((sum, q) => sum + q.remaining, 0);
  const queueRunning = !!activeAgent?.queueActive;
  const showBadge = queuedCount > 0;

  const [open, setOpen] = useState(false);
  // Selected target defaults to the active agent (if capable) each time the
  // popover opens; falls back to the first capable agent.
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [repeat, setRepeat] = useState(1);

  const target =
    targets.find(t => t.id === selectedTabId) ??
    targets.find(t => t.id === activeTabId) ??
    targets[0] ??
    null;
  const queue = target?.queue ?? [];
  const running = !!target?.queueActive;
  // The selector lists only the active agent (always, so you can add to it)
  // plus any agent that already HAS a queue — idle agents would just be
  // clutter. Anchored on activeTabId (not the live selection) so pills don't
  // vanish as you click between them.
  const agentQueued = (t: TerminalTab) => (t.queue ?? []).reduce((s, q) => s + q.remaining, 0);
  const selectorAgents = targets.filter(t => t.id === activeTabId || (t.queue?.length ?? 0) > 0);

  function onOpenChange(next: boolean) {
    if (next) {
      const preferred = targets.find(t => t.id === activeTabId) ?? targets[0];
      setSelectedTabId(preferred?.id ?? null);
      setDraft("");
      setRepeat(1);
    }
    setOpen(next);
  }

  function addMessage() {
    if (!target) return;
    const text = draft.trim();
    if (!text) return;
    const r = Math.min(MAX_REPEAT, Math.max(1, Math.round(repeat) || 1));
    const item: QueueItem = { id: crypto.randomUUID(), text, repeat: r, remaining: r };
    // queueActive:true marks it running; bumping queueKick is what actually
    // wakes TerminalPane's drain effect — relying on a queueActive false→true
    // edge would stall when the queue was already active (agent idle, empty
    // queue not yet flipped inactive).
    patchTab(wsId, target.id, {
      queue: [...(target.queue ?? []), item],
      queueActive: true,
      queueKick: (target.queueKick ?? 0) + 1,
    });
    setDraft("");
    setRepeat(1);
  }

  function removeItem(id: string) {
    if (!target) return;
    const next = queue.filter(q => q.id !== id);
    // Emptying the queue stops the loop so a later work-done doesn't fire a
    // stray "finished" toast.
    patchTab(wsId, target.id, next.length ? { queue: next } : { queue: [], queueActive: false });
  }

  function clearAll() {
    if (!target) return;
    patchTab(wsId, target.id, { queue: [], queueActive: false });
  }

  const tip = !canQueue
    ? "Run an agent here to queue messages for it"
    : showBadge
      ? `${queuedCount} queued · the next is sent when the agent finishes`
      : "Auto-send messages to the agent, one after each turn it finishes";

  return (
    <PopoverRoot open={open} onOpenChange={onOpenChange}>
      <Tip content={tip} side="top">
        {/* span wrapper so the tooltip still fires while disabled */}
        <span className={cn("inline-flex shrink-0", className)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!canQueue}
              className={cn(
                // Filled chip (no border — keeps the footer clean) so it reads
                // as a button via its background, not a faint label. text-[12.5px]
                // matches the right-panel footer tabs (Run/Setup) and the aux
                // strip; `compact` only adjusts the box, not the font.
                "flex shrink-0 items-center gap-1.5 rounded-md whitespace-nowrap text-[12.5px] transition-colors",
                compact ? "h-7 px-2" : "px-2 py-0.5",
                queueRunning
                  ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                  : "bg-[var(--color-bg-2)] text-[var(--color-fg)] hover:bg-[var(--color-bg-3)]",
                !canQueue && "cursor-not-allowed opacity-40 hover:bg-[var(--color-bg-2)]",
              )}
            >
              <MessageSquarePlus className={cn("h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]", queueRunning && "animate-pulse")} />
              <span className="tabular-nums">
                {showBadge ? `${queuedCount} queued` : "Queue messages"}
              </span>
            </button>
          </PopoverTrigger>
        </span>
      </Tip>

      <PopoverContent side="top" align="start" className="flex w-[360px] flex-col gap-2">
        {/* Agent selector — the active agent + any agent with a queue. Each
            shows its pending-message count. Hidden when there's nothing to
            pick between. */}
        {selectorAgents.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {selectorAgents.map(t => {
              const on = t.id === target?.id;
              const count = agentQueued(t);
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTabId(t.id)}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
                    on
                      ? "border-[var(--color-accent)] bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                      : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
                  )}
                >
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[t.cli])}>
                    <CliIcon cli={t.cli} className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 truncate">{tabLabel(t)}</span>
                  {count > 0 && (
                    <span className="shrink-0 rounded-full bg-[var(--color-accent)]/15 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-[var(--color-accent)]">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Queue list — head (next to send) on top, newest at the bottom. */}
        <div className="flex items-center justify-between text-[11px] text-[var(--color-fg-faint)]">
          <span>{queue.length === 0 ? "Queue empty" : `Queue (${queue.length})`}</span>
          {queue.length > 0 && (
            <button onClick={clearAll} className="hover:text-[var(--color-fg-dim)]">Clear all</button>
          )}
        </div>
        {queue.length > 0 && (
          <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
            {queue.map((q, i) => (
              <li
                key={q.id}
                className={cn(
                  "group flex items-start gap-2 rounded-md border px-2 py-1 text-[12.5px]",
                  running && i === 0
                    ? "border-[var(--color-accent)] bg-[var(--color-bg-2)]"
                    : "border-[var(--color-border)] bg-[var(--color-bg)]",
                )}
              >
                <span className="mt-0.5 w-3 shrink-0 text-right font-mono text-[10.5px] text-[var(--color-fg-faint)]">{i + 1}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[var(--color-fg)]">{q.text}</span>
                {q.repeat > 1 && (
                  <span className="mt-0.5 shrink-0 rounded bg-[var(--color-bg-3)] px-1 py-px font-mono text-[10.5px] text-[var(--color-fg-dim)]" title="Sends remaining">
                    ×{running && i === 0 ? q.remaining : q.repeat}
                  </span>
                )}
                <button
                  onClick={() => removeItem(q.id)}
                  title="Remove"
                  className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 transition-opacity hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Composer at the BOTTOM — type, Enter (or the arrow) to add. */}
        <div className="flex flex-col gap-1.5">
          <textarea
            autoFocus
            autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              // Enter adds; Shift+Enter inserts a newline (chat-composer convention).
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMessage(); }
            }}
            rows={2}
            placeholder="Add a message (e.g. continue)…"
            className="box-border max-h-32 min-h-[44px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[12.5px] leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[11.5px] text-[var(--color-fg-faint)]" title="Send this message N times (each waits for its own work-done)">
              <Repeat className="h-3 w-3" />
              <input
                type="number"
                min={1}
                max={MAX_REPEAT}
                value={repeat}
                spellCheck={false}
                onChange={e => setRepeat(Math.min(MAX_REPEAT, Math.max(1, Number(e.target.value) || 1)))}
                className="w-12 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-center font-mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              />
              ×
            </label>
            <Button variant="primary" size="sm" className="ml-auto gap-1.5" disabled={!draft.trim()} onClick={addMessage}>
              Add <CornerDownLeft className="h-3 w-3" />
            </Button>
          </div>
          <p className="text-[10.5px] leading-snug text-[var(--color-fg-faint)]">
            Sends on each work-done. A false "done" can advance early; remove items any time.
          </p>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
