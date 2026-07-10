// Pending review-comments affordance (GH issue #28). Appears in the footer
// once the user has left one or more inline comments anywhere in a
// task's diffs. Opens a popover that lists every pending comment
// (grouped by file, click to jump to the file), lets the user pick which
// running agent to send to, and fires the whole batch as one message.
//
// Delivery reuses the broadcast/queue path: write the composed text to the
// PTY, send the Enter a beat later (sendMessageToPty), and stamp lastInputAt
// so TerminalPane re-arms work-done detection.

import { useMemo, useState } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useTaskComments, useReviewComments, composeCommentsMessage } from "@/store/reviewComments";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { deliverMessage } from "@/lib/agentSend";
import { focusTerminalTab } from "@/lib/tabFocus";
import { isTerminalCli } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { MessagesSquare, X, Send, Trash2 } from "lucide-react";
import type { TerminalTab } from "@/lib/types";

function tabLabel(t: TerminalTab): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

function locLabel(start: number | null, end: number | null): string {
  if (start == null) return "whole file";
  if (end != null && end !== start) return `lines ${start}–${end}`;
  return `line ${start}`;
}

export function ReviewCommentsBar({ taskId, compact = false, className }: {
  taskId: string;
  compact?: boolean;
  className?: string;
}) {
  const comments = useTaskComments(taskId);
  const remove = useReviewComments(s => s.remove);
  const clear = useReviewComments(s => s.clear);

  const tabsForTask = useApp(s => s.tabs[taskId]);
  const agents = useApp(s => s.agents);
  const activeTabId = useApp(s => s.activeTab[taskId]);
  const patchTab = useApp(s => s.patchTab);
  const setActiveTabId = useApp(s => s.setActiveTabId);
  const openPreviewTab = useApp(s => s.openPreviewTab);
  const pushToast = useUI(s => s.pushToast);

  // Send targets: live AGENT terminals only. isTerminalCli excludes plain
  // shells, custom-command tabs, and registry "terminal"-kind entries — review
  // comments are instructions to act on, so they must not land in a raw shell
  // or a dev-server process.
  const targets = useMemo<TerminalTab[]>(
    () => (tabsForTask || []).filter(
      (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId && !isTerminalCli(t.cli, agents),
    ),
    [tabsForTask, agents],
  );

  const [open, setOpen] = useState(false);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Resolve the active target: explicit selection → active main tab → first.
  const target =
    targets.find(t => t.id === selectedTabId) ??
    targets.find(t => t.id === activeTabId) ??
    targets[0] ??
    null;

  const count = comments.length;
  if (count === 0) return null;

  function jumpTo(file: string) {
    openPreviewTab(taskId, { type: "diff", path: file, title: file.split("/").pop() || file });
    setOpen(false);
  }

  async function send() {
    if (!target?.ptyId || !comments.length || sending) return;
    const ptyId = target.ptyId;
    const label = tabLabel(target);
    const n = comments.length;
    const msg = composeCommentsMessage(comments);
    setSending(true);
    try {
      // Await the write so we only clear the user's comments once they've
      // actually reached the PTY — a dead/exited agent rejects here and the
      // batch is preserved.
      await deliverMessage(ptyId, msg);
    } catch {
      setSending(false);
      pushToast(`Could not reach ${label}. Your comments are kept.`, "error");
      return;
    }
    // Arm work-done detection exactly as a keyboard Enter would (delivery
    // writes straight to the PTY, bypassing term.onData).
    patchTab(taskId, target.id, { lastInputAt: Date.now() });
    clear(taskId);
    setSending(false);
    setOpen(false);
    // Surface the agent we just sent to: switch to its tab and drop keyboard
    // focus into the terminal so the user can keep steering it immediately.
    setActiveTabId(taskId, target.id);
    focusTerminalTab(target.id);
    pushToast(`Sent ${n} comment${n === 1 ? "" : "s"} to ${label}`);
  }

  // Group comments by file, preserving first-seen order.
  const byFile = new Map<string, typeof comments>();
  for (const c of comments) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr as typeof comments);
  }

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Tip content={`${count} pending review comment${count === 1 ? "" : "s"}`} side="top">
        <span className={cn("inline-flex shrink-0", className)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md whitespace-nowrap font-medium text-[12.5px] transition-colors",
                compact ? "h-7 px-2.5" : "px-2.5 py-1",
                // Loud filled-accent CTA so pending comments can't be missed.
                "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-deep)] hover:text-white",
                // Pulse only while closed — once the popover is open the user
                // is already acting on them, no need to keep shouting.
                !open && "termic-review-pending",
              )}
            >
              <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
              <span className="tabular-nums">{count} pending comment{count === 1 ? "" : "s"}</span>
            </button>
          </PopoverTrigger>
        </span>
      </Tip>

      <PopoverContent side="top" align="start" className="flex w-[380px] flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-[var(--color-fg)]">
            Review comments
          </span>
          <button
            onClick={() => { clear(taskId); setOpen(false); }}
            className="flex items-center gap-1 text-[11px] text-[var(--color-fg-faint)] hover:text-[var(--color-err)]"
          >
            <Trash2 className="h-3 w-3" /> Discard all
          </button>
        </div>

        {/* Comment list, grouped by file. Click the location to jump to the
            file's diff; X removes a single comment. */}
        <ul className="flex max-h-[44vh] flex-col gap-2 overflow-y-auto">
          {[...byFile.entries()].map(([file, list]) => (
            <li key={file} className="flex flex-col gap-1">
              <button
                onClick={() => jumpTo(file)}
                title="Open this file's diff"
                className="truncate text-left font-mono text-[11px] text-[var(--color-fg-dim)] hover:text-[var(--color-accent)]"
              >
                {file}
              </button>
              {list.map(c => (
                <div
                  key={c.id}
                  className="group flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[10.5px] text-[var(--color-fg-faint)]">
                      {locLabel(c.startLine, c.endLine)}
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-[var(--color-fg)]">
                      {c.body}
                    </div>
                  </div>
                  <button
                    onClick={() => remove(taskId, c.id)}
                    title="Remove comment"
                    className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 transition-opacity hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </li>
          ))}
        </ul>

        {/* Agent picker — only when there's a choice to make. */}
        {targets.length > 1 && (
          <div className="flex flex-wrap gap-1 border-t border-[var(--color-border-soft)] pt-2">
            {targets.map(t => {
              const on = t.id === target?.id;
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
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(t.cli, agents)] || "text-[var(--color-fg-dim)]")}>
                    <CliIcon cli={resolveIconId(t.cli, agents)} className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 truncate">{tabLabel(t)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--color-fg-faint)]">
            {target
              ? <>Sends to <span className="text-[var(--color-fg-dim)]">{tabLabel(target)}</span></>
              : "No running agent in this task"}
          </span>
          <Button variant="primary" size="sm" className="gap-1.5" disabled={!target || sending} onClick={send}>
            <Send className="h-3.5 w-3.5" /> {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
