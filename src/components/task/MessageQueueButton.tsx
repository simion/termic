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
// one work-done-capable agent is running in the task.
//
// "Send after" (GH #300) turns the message into a scheduled one: one-shot,
// saved with the tab, sent the first time this chat is open and idle on or
// after the date. The copy under the picker states that ceiling and must
// never promise a time.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { workDoneCapable } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { MessageSquarePlus, X, Repeat, CornerDownLeft, Send, CalendarClock } from "lucide-react";
import type { TerminalTab } from "@/lib/types";
import { dateInputValue, formatScheduleDate, isScheduled, localDateValue, startOfDayIn } from "@/lib/scheduledQueue";

/** "Send after" presets, in days from today. Each resolves to local midnight
 *  of that day, so "in a week" still sends that morning. Labels are i18n keys
 *  into the queue subtree, resolved at render. */
const SCHEDULE_PRESETS: Array<{ key: string; days: number }> = [
  { key: "tomorrow", days: 1 },
  { key: "in3Days", days: 3 },
  { key: "inWeek", days: 7 },
];

const MAX_REPEAT = 99;

function tabLabel(t: TerminalTab): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

export function MessageQueueButton({ taskId, compact = false, className, preferTabId }: {
  taskId: string;
  /** Icon-only rendering for tight spots like the split terminal's tab strip
   *  (vs. icon + "Queue messages" text in the bottom status bar). */
  compact?: boolean;
  /** Extra classes for the trigger wrapper (e.g. `ml-auto` to sit by a caret). */
  className?: string;
  /** Override which agent this button defaults to (badge + pre-selected
   *  target). Used by the right-split footer button so it targets the right
   *  pane's agent instead of the main pane's active tab. */
  preferTabId?: string;
}) {
  const { t } = useTranslation("task");
  const tabsForTask = useApp(s => s.tabs[taskId]);
  const activeTabId = useApp(s => s.activeTab[taskId]);
  // The agent this button defaults to: an explicit override (right-pane
  // button) or the main pane's active tab.
  const defaultTabId = preferTabId ?? activeTabId;
  const agents = useApp(s => s.agents);
  const patchTab = useApp(s => s.patchTab);
  const enqueueAgentMessage = useApp(s => s.enqueueAgentMessage);
  const scheduleAgentMessage = useApp(s => s.scheduleAgentMessage);
  const syncScheduledMessages = useApp(s => s.syncScheduledMessages);
  const forceAgentQueueSend = useApp(s => s.forceAgentQueueSend);

  // Only work-done-capable agent tabs with a live PTY can host a queue — the
  // loop advances on work-done, which shells / detection-off agents never emit.
  const targets = useMemo<TerminalTab[]>(
    () => (tabsForTask || []).filter(
      (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId && workDoneCapable(t.cli, agents),
    ),
    [tabsForTask, agents],
  );
  const canQueue = targets.length > 0;

  // The button badge reflects ONLY the active agent (the one in the main pane),
  // not a task-wide sum — a count from a different agent's queue here is
  // confusing. The popover still lists every agent via the selector.
  const activeAgent = targets.find(t => t.id === defaultTabId);
  const queuedCount = (activeAgent?.queue ?? []).reduce((sum, q) => sum + q.remaining, 0);
  const scheduledCount = (activeAgent?.queue ?? []).filter(isScheduled).length;
  const queueRunning = !!activeAgent?.queueActive;
  const showBadge = queuedCount > 0;
  // Scheduled-only reads "1 scheduled": "1 queued" suggests it is next up.
  const badgeLabel = queuedCount > scheduledCount
    ? t("queue.queuedBadge", { count: queuedCount })
    : t("queue.scheduledBadge", { count: scheduledCount });

  const [open, setOpen] = useState(false);
  // Selected target defaults to the active agent (if capable) each time the
  // popover opens; falls back to the first capable agent.
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [repeat, setRepeat] = useState(1);
  // "Send after" as local-midnight epoch ms, or null for an ordinary item.
  const [notBefore, setNotBefore] = useState<number | null>(null);
  // The date field only exists once asked for: an EMPTY date input in WebKit
  // renders today's date, which reads as a date already picked.
  const [pickingDate, setPickingDate] = useState(false);

  const target =
    targets.find(t => t.id === selectedTabId) ??
    targets.find(t => t.id === defaultTabId) ??
    targets[0] ??
    null;
  const queue = target?.queue ?? [];
  const running = !!target?.queueActive;
  // The selector lists only the active agent (always, so you can add to it)
  // plus any agent that already HAS a queue — idle agents would just be
  // clutter. Anchored on activeTabId (not the live selection) so pills don't
  // vanish as you click between them.
  const agentQueued = (t: TerminalTab) => (t.queue ?? []).reduce((s, q) => s + q.remaining, 0);
  const selectorAgents = targets.filter(t => t.id === defaultTabId || (t.queue?.length ?? 0) > 0);

  function onOpenChange(next: boolean) {
    if (next) {
      const preferred = targets.find(t => t.id === defaultTabId) ?? targets[0];
      setSelectedTabId(preferred?.id ?? null);
      setDraft("");
      setRepeat(1);
      setNotBefore(null);
      setPickingDate(false);
    }
    setOpen(next);
  }

  function addMessage() {
    if (!target) return;
    const text = draft.trim();
    if (!text) return;
    if (notBefore != null) {
      scheduleAgentMessage(taskId, target.id, text, notBefore);
      setDraft("");
      setNotBefore(null);
      setPickingDate(false);
      return;
    }
    const r = Math.min(MAX_REPEAT, Math.max(1, Math.round(repeat) || 1));
    // enqueueAgentMessage owns the queueKick-bump protocol (see app store):
    // bumping queueKick is what wakes TerminalPane's drain effect; a
    // queueActive false->true edge would stall when the queue was already active.
    enqueueAgentMessage(taskId, target.id, text, r);
    setDraft("");
    setRepeat(1);
  }

  function removeItem(id: string) {
    if (!target) return;
    const next = queue.filter(q => q.id !== id);
    // Emptying the queue stops the loop so a later work-done doesn't fire a
    // stray "finished" toast.
    patchTab(taskId, target.id, next.length ? { queue: next } : { queue: [], queueActive: false });
    syncScheduledMessages(taskId, target.id);
  }

  function clearAll() {
    if (!target) return;
    patchTab(taskId, target.id, { queue: [], queueActive: false });
    syncScheduledMessages(taskId, target.id);
  }

  function sendNow() {
    if (!target || queue.length === 0) return;
    forceAgentQueueSend(taskId, target.id);
  }

  const tip = !canQueue
    ? t("queue.tipRunAgent")
    : showBadge
      ? queuedCount > scheduledCount
        ? t("queue.tipQueued", { count: queuedCount })
        : t("queue.tipScheduled", { count: scheduledCount })
      : t("queue.tipIdle");

  return (
    <PopoverRoot open={open} onOpenChange={onOpenChange}>
      <Tip content={tip} side="top">
        {/* span wrapper so the tooltip still fires while disabled */}
        <span className={cn("inline-flex shrink-0", className)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!canQueue}
              // DOM hook for the e2e suite: how many messages are waiting, and
              // whether the loop is mid-send. Same numbers the label shows.
              data-testid="queue-button"
              data-queued={queuedCount}
              data-scheduled={scheduledCount}
              data-queue-running={queueRunning ? "1" : "0"}
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
              {/* The COUNT survives the collapse, the words do not: "3
                  queued" is a number you are watching, "Queue messages" is a
                  label for a button whose icon already says it. */}
              <span className={cn("tabular-nums", !showBadge && "@max-[680px]:hidden")}>
                {showBadge ? badgeLabel : t("queue.button")}
              </span>
            </button>
          </PopoverTrigger>
        </span>
      </Tip>

      <PopoverContent side="top" align="start" className="flex w-[480px] flex-col gap-2">
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
                    <CliIcon cli={resolveIconId(t.cli, agents)} className="h-3.5 w-3.5" />
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
          <span>{queue.length === 0 ? t("queue.empty") : t("queue.count", { count: queue.length })}</span>
          {queue.length > 0 && (
            <button onClick={clearAll} className="hover:text-[var(--color-fg-dim)]">{t("queue.clearAll")}</button>
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
                {q.notBefore != null && (
                  <Tip content={t("queue.scheduledTip", { date: formatScheduleDate(q.notBefore) })} side="top">
                    <span
                      data-testid="queue-item-scheduled"
                      className="mt-0.5 flex shrink-0 items-center gap-1 rounded bg-[var(--color-bg-3)] px-1 py-px text-[10.5px] text-[var(--color-fg-dim)]"
                    >
                      <CalendarClock className="h-3 w-3" />
                      {q.notBefore <= Date.now() ? t("queue.due") : formatScheduleDate(q.notBefore)}
                    </span>
                  </Tip>
                )}
                {q.repeat > 1 && (
                  <span className="mt-0.5 shrink-0 rounded bg-[var(--color-bg-3)] px-1 py-px font-mono text-[10.5px] text-[var(--color-fg-dim)]" title={t("queue.repeatCountTip")}>
                    ×{running && i === 0 ? q.remaining : q.repeat}
                  </span>
                )}
                <button
                  onClick={() => removeItem(q.id)}
                  title={t("queue.removeTip")}
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
            placeholder={t("queue.placeholder")}
            className="box-border max-h-32 min-h-[44px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[12.5px] leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex flex-wrap items-center gap-1" data-testid="queue-send-after">
            <span className="mr-0.5 flex items-center gap-1 text-[11.5px] text-[var(--color-fg-faint)]">
              <CalendarClock className="h-3 w-3" /> {t("queue.sendAfter")}
            </span>
            {[{ key: "nextTurn", days: 0 }, ...SCHEDULE_PRESETS].map(p => {
              const value = p.days === 0 ? null : startOfDayIn(p.days);
              const on = !pickingDate && notBefore === value;
              return (
                <button
                  key={p.key}
                  type="button"
                  data-testid={`queue-send-after-${p.days}`}
                  aria-pressed={on}
                  onClick={() => { setPickingDate(false); setNotBefore(value); }}
                  className={cn(
                    "rounded-md border px-1.5 py-px text-[11.5px]",
                    on
                      ? "border-[var(--color-accent)] bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                      : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
                  )}
                >
                  {t(`queue.${p.key}`)}
                </button>
              );
            })}
            {pickingDate ? (
              <input
                type="date"
                data-testid="queue-send-after-date"
                min={dateInputValue(startOfDayIn(1))}
                value={dateInputValue(notBefore ?? startOfDayIn(1))}
                onChange={e => {
                  const ms = localDateValue(e.target.value);
                  // Today or earlier would be due at once; clamp to tomorrow.
                  setNotBefore(ms != null && ms >= startOfDayIn(1) ? ms : startOfDayIn(1));
                }}
                className="rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-px font-mono text-[11.5px] text-[var(--color-fg)] outline-none"
              />
            ) : (
              <button
                type="button"
                data-testid="queue-send-after-pick"
                onClick={() => { setPickingDate(true); setNotBefore(startOfDayIn(1)); }}
                className="rounded-md border border-[var(--color-border)] px-1.5 py-px text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]"
              >
                {t("queue.pickDate")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {notBefore == null && <label className="flex items-center gap-1 text-[11.5px] text-[var(--color-fg-faint)]" title={t("queue.repeatTip")}>
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
            </label>}
            {queue.length > 0 && (
              <Tip content={t("queue.sendNowTip")} side="top">
                <Button variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={sendNow}>
                  <Send className="h-3 w-3" /> {t("queue.sendNow")}
                </Button>
              </Tip>
            )}
            <Button variant="primary" size="sm" className={cn("gap-1.5", queue.length === 0 && "ml-auto")} disabled={!draft.trim()} onClick={addMessage}>
              {notBefore == null ? t("queue.add") : t("queue.schedule")} <CornerDownLeft className="h-3 w-3" />
            </Button>
          </div>
          <p className="text-[10.5px] leading-snug text-[var(--color-fg-faint)]" data-testid="queue-hint">
            {notBefore == null
              ? t("queue.hintQueue")
              : t("queue.hintScheduled", { date: formatScheduleDate(notBefore) })}
          </p>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
