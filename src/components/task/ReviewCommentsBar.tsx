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
import { useTranslation, Trans } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useTaskComments, useReviewComments } from "@/store/reviewComments";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { sendCommentsToAgent } from "@/lib/sendComments";
import { isTerminalCli } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { MessagesSquare, X, Send, Trash2 } from "lucide-react";
import type { TerminalTab } from "@/lib/types";

function tabLabel(t: TerminalTab): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

function locLabel(t: TFunction, start: number | null, end: number | null): string {
  if (start == null) return t("reviewBar.wholeFile");
  if (end != null && end !== start) return t("reviewBar.lines", { start, end });
  return t("reviewBar.line", { start });
}

export function ReviewCommentsBar({ taskId, compact = false, className }: {
  taskId: string;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("panels");
  const comments = useTaskComments(taskId);
  const remove = useReviewComments(s => s.remove);
  const clear = useReviewComments(s => s.clear);

  const tabsForTask = useApp(s => s.tabs[taskId]);
  const agents = useApp(s => s.agents);
  const activeTabId = useApp(s => s.activeTab[taskId]);
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
    setSending(true);
    // Shared with the composer's own Send button (lib/sendComments.ts): one
    // delivery path, so target resolution, the lastInputAt stamp, the focus
    // handover and the toast can't drift between the two entry points. Only
    // clear once the bytes actually landed — a dead agent keeps the batch.
    const ok = await sendCommentsToAgent(taskId, comments, { tabId: target.id });
    setSending(false);
    if (!ok) return;
    clear(taskId);
    setOpen(false);
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
      <Tip content={count === 1 ? t("reviewBar.pendingTipOne") : t("reviewBar.pendingTipMany", { count })} side="top">
        <span className={cn("inline-flex shrink-0", className)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="review-comments-pill"
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
              <span className="tabular-nums">{count === 1 ? t("reviewBar.pendingOne") : t("reviewBar.pendingMany", { count })}</span>
            </button>
          </PopoverTrigger>
        </span>
      </Tip>

      <PopoverContent side="top" align="start" className="flex w-[380px] flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-[var(--color-fg)]">
            {t("reviewBar.title")}
          </span>
          <button
            onClick={() => { clear(taskId); setOpen(false); }}
            className="flex items-center gap-1 text-[11px] text-[var(--color-fg-faint)] hover:text-[var(--color-err)]"
          >
            <Trash2 className="h-3 w-3" /> {t("reviewBar.discardAll")}
          </button>
        </div>

        {/* Comment list, grouped by file. Click the location to jump to the
            file's diff; X removes a single comment. */}
        <ul className="flex max-h-[44vh] flex-col gap-2 overflow-y-auto">
          {[...byFile.entries()].map(([file, list]) => (
            <li key={file} className="flex flex-col gap-1">
              <button
                onClick={() => jumpTo(file)}
                title={t("reviewBar.openDiff")}
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
                      {locLabel(t, c.startLine, c.endLine)}
                    </div>
                    {/* The body is optional when a selection was queued on its
                        own, so fall back to naming that rather than showing an
                        empty row. */}
                    <div className={cn(
                      "mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-snug",
                      c.body.trim() ? "text-[var(--color-fg)]" : "italic text-[var(--color-fg-faint)]",
                    )}>
                      {c.body.trim() || t("reviewBar.selectionOnly")}
                    </div>
                  </div>
                  <button
                    onClick={() => remove(taskId, c.id)}
                    title={t("reviewBar.removeComment")}
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
              ? <Trans i18nKey="reviewBar.sendsTo" values={{ label: tabLabel(target) }} components={{ span: <span className="text-[var(--color-fg-dim)]" /> }} />
              : t("reviewBar.noAgent")}
          </span>
          <Button variant="primary" size="sm" className="gap-1.5" data-testid="review-comments-send"
                  disabled={!target || sending} onClick={send}>
            <Send className="h-3.5 w-3.5" /> {sending ? t("reviewBar.sending") : t("reviewBar.send")}
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
