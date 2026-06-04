// Per-agent message queue (the "ralph loop"). Queue up messages for one
// agent; each time that agent signals work-done, the next message is sent
// automatically. A per-message repeat count re-sends the same message N
// times (each waiting for its own work-done) — a single high-repeat item is
// a self-driving loop. Queues are per-agent: each terminal tab drains on its
// own completion, so several agents can loop in parallel. The queue state
// lives on the TerminalTab (queue / queueActive); the draining engine is in
// TerminalPane. Only work-done-capable agents are offered (a shell, or an
// agent with work-done detection turned off, can't gate "send next").

import { useEffect, useMemo, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { workDoneCapable } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { Plus, Play, Square, X, Repeat } from "lucide-react";
import type { TerminalTab, QueueItem } from "@/lib/types";

function tabLabel(t: TerminalTab): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

const MAX_REPEAT = 99;

export function MessageQueueDialog() {
  const wsId = useUI(s => s.queueForWsId);
  const close = useUI(s => s.closeQueue);
  const pushToast = useUI(s => s.pushToast);
  const tabsForWs = useApp(s => (wsId ? s.tabs[wsId] : undefined));
  const activeTabId = useApp(s => (wsId ? s.activeTab[wsId] : undefined));
  const agents = useApp(s => s.agents);
  const patchTab = useApp(s => s.patchTab);

  // Only work-done-capable agent tabs with a live PTY can host a queue —
  // the loop advances on work-done, which shells / detection-off agents
  // never emit.
  const targets = useMemo<TerminalTab[]>(
    () => (tabsForWs || []).filter(
      (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId && workDoneCapable(t.cli, agents),
    ),
    [tabsForWs, agents],
  );

  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [repeat, setRepeat] = useState(1);

  // (Re-)open: default the target to the active agent if it qualifies, else
  // the first capable agent. Reset the add-message form.
  useEffect(() => {
    if (!wsId) return;
    const preferred = targets.find(t => t.id === activeTabId) ?? targets[0];
    setSelectedTabId(preferred?.id ?? null);
    setDraft("");
    setRepeat(1);
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = targets.find(t => t.id === selectedTabId) ?? null;
  const queue = target?.queue ?? [];
  const running = !!target?.queueActive;

  function addMessage() {
    if (!wsId || !target) return;
    const text = draft.trim();
    if (!text) return;
    const r = Math.min(MAX_REPEAT, Math.max(1, Math.round(repeat) || 1));
    const item: QueueItem = { id: crypto.randomUUID(), text, repeat: r, remaining: r };
    patchTab(wsId, target.id, { queue: [...queue, item] });
    setDraft("");
    setRepeat(1);
  }

  function removeItem(id: string) {
    if (!wsId || !target) return;
    patchTab(wsId, target.id, { queue: queue.filter(q => q.id !== id) });
  }

  function start() {
    if (!wsId || !target || !queue.length) return;
    patchTab(wsId, target.id, { queueActive: true });
    pushToast(`Queue started for ${tabLabel(target)}`);
  }

  function stop() {
    if (!wsId || !target) return;
    patchTab(wsId, target.id, { queueActive: false });
  }

  function clearAll() {
    if (!wsId || !target) return;
    patchTab(wsId, target.id, { queue: [], queueActive: false });
  }

  return (
    <AppDialog
      open={!!wsId}
      onOpenChange={(v) => (v ? null : close())}
      title="Message queue"
      description="Queue messages for an agent. Each time it finishes a turn, the next message is sent automatically."
      className="max-w-lg"
    >
      {targets.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-[var(--color-fg-dim)]">
          No work-done-capable agents are running in this workspace. Open an
          agent tab (with work-done detection enabled) to queue messages.
        </p>
      ) : (
        <>
          {/* Target selector — queues are per-agent, so pick which one. */}
          {targets.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {targets.map(t => {
                const on = t.id === selectedTabId;
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTabId(t.id)}
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px] transition-colors",
                      on
                        ? "border-[var(--color-accent)] bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                        : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
                    )}
                  >
                    <span className={cn("shrink-0", CLI_BRAND_COLOR[t.cli])}>
                      <CliIcon cli={t.cli} className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 truncate">{tabLabel(t)}</span>
                    {t.queueActive && (
                      <Repeat className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Add-message form: message + repeat count. */}
          <div className="mt-3">
            <textarea
              autoFocus
              autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                // Enter inserts a newline; Cmd/Ctrl+Enter adds the message.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addMessage(); }
              }}
              rows={3}
              placeholder="Message to queue (e.g. continue)…"
              className="box-border min-h-[72px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 font-mono text-[13px] leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
            <div className="mt-2 flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
                <Repeat className="h-3.5 w-3.5" />
                Repeat
                <input
                  type="number"
                  min={1}
                  max={MAX_REPEAT}
                  value={repeat}
                  spellCheck={false}
                  onChange={e => setRepeat(Math.min(MAX_REPEAT, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-16 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-center font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                />
                <span className="text-[var(--color-fg-faint)]">{repeat === 1 ? "time" : "times"}</span>
              </label>
              <Button variant="secondary" size="sm" className="ml-auto" disabled={!draft.trim()} onClick={addMessage}>
                <Plus className="h-3.5 w-3.5" /> Add to queue
              </Button>
            </div>
          </div>

          {/* The queue itself. Head is sent next; counts decrement live. */}
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-[11.5px] text-[var(--color-fg-faint)]">
              <span>Queue ({queue.length})</span>
              {queue.length > 0 && (
                <button onClick={clearAll} className="hover:text-[var(--color-fg-dim)]">Clear all</button>
              )}
            </div>
            {queue.length === 0 ? (
              <p className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[12.5px] text-[var(--color-fg-faint)]">
                No messages queued yet.
              </p>
            ) : (
              <ul className="flex max-h-[34vh] flex-col gap-1 overflow-y-auto">
                {queue.map((q, i) => (
                  <li
                    key={q.id}
                    className={cn(
                      "group flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[13px]",
                      running && i === 0
                        ? "border-[var(--color-accent)] bg-[var(--color-bg-2)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)]",
                    )}
                  >
                    <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-[11px] text-[var(--color-fg-faint)]">{i + 1}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[var(--color-fg)]">{q.text}</span>
                    {q.repeat > 1 && (
                      <span className="mt-0.5 shrink-0 rounded bg-[var(--color-bg-3)] px-1.5 py-px font-mono text-[11px] text-[var(--color-fg-dim)]" title="Sends remaining">
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
          </div>

          <p className="mt-2 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
            Messages send only when the agent reports work-done, so a false
            "done" can advance early. Hit Stop any time.
          </p>

          <div className="mt-3 flex items-center justify-end gap-2">
            {running ? (
              <Button variant="danger" size="sm" onClick={stop}>
                <Square className="h-3.5 w-3.5" /> Stop
              </Button>
            ) : (
              <Button variant="primary" size="sm" disabled={!queue.length} onClick={start}>
                <Play className="h-3.5 w-3.5" /> Start
              </Button>
            )}
          </div>
        </>
      )}
    </AppDialog>
  );
}
